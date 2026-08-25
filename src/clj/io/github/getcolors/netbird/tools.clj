(ns io.github.getcolors.netbird.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.netbird.ssh-config :as ssh-config]
            [io.github.getcolors.netbird.validate :as validate]))

(def infrastructure-tool "netbird-infrastructure")
(def dns-tool "netbird-dns")
(def ansible-tool "netbird-ansible")
(def ansible-local-tool "netbird-ansible-local")
(def root "io.github.getcolors.netbird.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "netbird"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn cidrs [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn fallback-params [opts]
  {:ip "192.0.2.10" :user "root" :sudoer "root" :name (validate/compute-name opts)})
(defn output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

;; ---------------------------------------------------------------- compute

(defn infrastructure-data [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :compute-name (validate/compute-name opts)
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts :vultr-ssh-sources))
         :http-sources-hcl (tofu/hcl-list (cidrs opts :vultr-http-sources))
         :stun-sources-hcl (tofu/hcl-list (cidrs opts :vultr-stun-sources))))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        specs [(spec (template "infrastructure" "main.tf") (str dir "/main.tf")
                     (infrastructure-data opts))]
        result (tofu/tofu-with-spec opts specs
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (merge result (fallback-params opts) (output-params result)))))

;; -------------------------------------------------------------------- dns

(defn dns-json
  "Two explicit records, both unproxied.

  Unproxied because Cloudflare's proxy is an HTTP proxy: UDP STUN on 3478 does
  not survive it, and TLS-ALPN-01 — which is how these certificates are issued
  — terminates at the proxy rather than at Traefik. `signoz` proxies its single
  record; this deployment cannot.

  Two explicit names rather than a wildcard. The upstream article needs a
  wildcard because it exposes services through NetBird's own reverse proxy;
  this package routes Authentik with Traefik directly, so nothing resolves
  under the wildcard and publishing one would only widen the surface a future
  catch-all router could serve."
  [opts]
  (tofu/constructs-json
   [(tofu/construct :resource :cloudflare_dns_record :netbird
                    {:zone_id "${data.cloudflare_zone.zone.id}"
                     :name (:netbird-host opts) :content (:ip opts) :type "A"
                     :proxied false :ttl 60})
    (tofu/construct :resource :cloudflare_dns_record :authentik
                    {:zone_id "${data.cloudflare_zone.zone.id}"
                     :name (:netbird-authentik-host opts) :content (:ip opts) :type "A"
                     :proxied false :ttl 60})]))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (assoc opts
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :netbird-zone (validate/zone opts))
        specs [(spec (template "dns" "main.tf") (str dir "/main.tf") data)
               (raw-spec (str dir "/record.tf.json") (dns-json data))]]
    (tofu/tofu-with-spec opts specs {:dir dir :env (credential-env opts :provider-dns)})))

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ---------------------------------------------------------------- ansible

(defn inventory [opts]
  (json/generate-string
   {:all {:children {:netbird {:hosts {(:profile opts)
                                       {:ansible_host (or (:ip opts) "192.0.2.10")
                                        :ansible_user "root"}}}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the Ansible stage.

  Deliberately carries none of the operator secrets. They reach the host as
  Ansible `lookup('env', ...)` expressions written literally into main.yml,
  where `preserve-jinja-delimiters` passes them through untouched — routing
  them through this map instead would let Selmer HTML-escape the quotes and
  hand Ansible `&#39;`. The secret therefore exists only in the process that
  needs it: not in `.colors/`, not in a golden, not in this map."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :traefik-ip (validate/traefik-ip opts)
         :ssh-keygen (validate/keygen? opts)))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible" "main.yml") (str dir "/main.yml") data)
     (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
     (spec (template "ansible" "compose.yml") (str dir "/compose.yml") data)
     (spec (template "ansible" "config.yaml") (str dir "/config.yaml") data)
     (spec (template "ansible" "dashboard.env") (str dir "/dashboard.env") data)
     (spec (template "ansible" "blueprint.yaml") (str dir "/blueprint.yaml") data)
     (spec (template "ansible" "bootstrap.sh") (str dir "/bootstrap.sh") data)
     (spec (template "ansible" "smoke.sh") (str dir "/smoke.sh") data)
     (spec (template "ansible" "s3.py") (str dir "/s3.py") data)
     (spec (template "ansible" "backup.sh") (str dir "/backup.sh") data)
     (spec (template "ansible" "restore.sh") (str dir "/restore.sh") data)
     (spec (template "ansible" "status.sh") (str dir "/status.sh") data)
     (spec (template "ansible" "backup.service") (str dir "/backup.service") data)
     (spec (template "ansible" "backup-failure.service") (str dir "/backup-failure.service") data)
     (spec (template "ansible" "backup.timer") (str dir "/backup.timer") data)
     (raw-spec (str dir "/inventory.json") (inventory data))]))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (not (:ip opts)))
      ;; No compute in state: there is no host to stop, and the cleanup play
      ;; would only fail against the placeholder address.
      (assoc opts :green/exit 0)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "main.yml" :delete "cleanup.yml"}
         :host-key-checking false}
        (ansible-specs opts)))))

;; ------------------------------------------------------------- acceptance

(defn wait-for
  "True once `args` exits zero, retrying every five seconds."
  [args attempts]
  (loop [n attempts]
    (let [r (process/run-with-timeout args {} 20000)]
      (cond (zero? (:exit r)) true
            (pos? n) (do (Thread/sleep 5000) (recur (dec n)))
            :else false))))

(defn run [args] (process/run-with-timeout args {} 20000))
(defn out [args] (str/trim (str (:out (run args)))))

(defn cert-error
  "Why the certificate for `host` is not acceptable, or nil when it is.

  Traefik answers 443 with a self-signed default certificate when ACME has
  failed, so a reachable HTTPS endpoint proves nothing on its own. Three
  separate facts are checked: the chain validates against the system trust
  store (`curl` without `-k` fails otherwise), the certificate names this host,
  and it is not about to expire. Matching the issuer string against \"Let's
  Encrypt\" would be the brittle version — chains get renamed, and a renamed
  chain is not an outage."
  [host]
  (let [s-client (str "echo | openssl s_client -servername " host
                      " -connect " host ":443 2>/dev/null")]
    (cond
      (not (zero? (:exit (run ["curl" "-fsS" "-o" "/dev/null" (str "https://" host "/")]))))
      (str "the certificate for " host " is not trusted by the system store; Traefik is "
           "probably serving its self-signed default because ACME failed")

      (not (str/includes?
            (out ["sh" "-c" (str s-client " | openssl x509 -noout -ext subjectAltName")])
            host))
      (str "the certificate served for " host " does not name it")

      (not (zero? (:exit (run ["sh" "-c" (str s-client
                                              " | openssl x509 -noout -checkend 604800")]))))
      (str "the certificate for " host " expires within seven days and has not renewed")

      :else nil)))

(defn closed?
  "Whether a TCP port refuses a connection from out here. `bind to loopback`
  regresses silently while every positive check still passes, so absence is
  asserted rather than assumed."
  [host port]
  (not (zero? (:exit (run ["sh" "-c" (str "timeout 5 bash -c '</dev/tcp/" host "/" port "' 2>/dev/null")])))))

(defn acceptance-step
  "Public health checks after a real create.

  What runs here is what the internet can see. The end-to-end proofs that need
  the host's own credentials — the device-code grant, two peers exchanging
  traffic over the relay — run inside the playbook, where the durable PAT
  lives."
  [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [host (:netbird-host opts)
          ak (:netbird-authentik-host opts)
          ip (:ip opts)]
      (cond
        (not (wait-for ["curl" "-fsS" "-o" "/dev/null" (str "https://" host "/")] 60))
        (assoc opts :green/exit 1
               :green/err "the NetBird dashboard did not become reachable over HTTPS")

        :else
        (let [cert-errs (keep cert-error [host ak])
              disco (out ["curl" "-fsS" (str "https://" ak
                                             "/application/o/netbird/.well-known/openid-configuration")])
              ;; Ports that must not be open from outside. Postgres, Redis and
              ;; Authentik's own 9000 are reachable only on the compose
              ;; network; the article opens 9000 for first-run setup, and this
              ;; package never does.
              open (remove #(closed? ip %) [5432 6379 9000 9090 8080])]
          (cond
            (seq cert-errs)
            (assoc opts :green/exit 1 :green/err (str/join "; " cert-errs))

            (not (str/includes? disco "device_authorization_endpoint"))
            (assoc opts :green/exit 1
                   :green/err (str "the Authentik issuer does not advertise a device "
                                   "authorization endpoint; CLI enrolment would fail"))

            (seq open)
            (assoc opts :green/exit 1
                   :green/err (str "ports that must not be public answered: "
                                   (str/join ", " open)))

            :else
            (assoc opts :green/exit 0
                   :netbird/acceptance {:dashboard "ok"
                                        :certificates "trusted"
                                        :oidc "complete"
                                        :closed-ports "confirmed"})))))))

(ns io.github.getcolors.netbird.tools-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.netbird.tools :as tools]
            [io.github.getcolors.netbird.validate :as validate]
            [io.github.getcolors.netbird.validate-test :refer [fixture optout]]))

(defn- spec-for [opts file]
  (some #(when (str/ends-with? (str (:target %)) file) %) (tools/ansible-specs opts)))

(deftest firewall-sources-parse
  (let [data (tools/infrastructure-data (fixture))]
    (is (= ["0.0.0.0/0"] (tools/cidrs data :vultr-http-sources)))
    (is (= ["0.0.0.0/0"] (tools/cidrs data :vultr-stun-sources)))))

(deftest infrastructure-data-carries-the-ssh-mode
  (is (true? (:ssh-keygen (tools/infrastructure-data (fixture)))))
  (is (false? (:ssh-keygen (tools/infrastructure-data (optout))))))

(deftest every-label-derives-from-one-resolved-name
  ;; Compute Name Standard §3: one function answers "what is this deployment's
  ;; machine called", and the firewall asks it too rather than keeping a second
  ;; copy of the profile.
  (let [data (tools/infrastructure-data (fixture :vultr-name "override-box"))]
    (is (= "override-box" (:compute-name data)))))

(deftest dns-zone-is-registrable-domain
  (is (= "example.com" (validate/zone (fixture)))))

(deftest dns-creates-both-names-unproxied
  ;; Unproxied because Cloudflare's proxy is an HTTP proxy: UDP STUN does not
  ;; survive it and TLS-ALPN-01 would terminate at the proxy, not at Traefik.
  (let [json (tools/dns-json (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? json "netbird.example.com"))
    (is (str/includes? json "authentik.example.com"))
    (is (str/includes? json "192.0.2.10"))
    (is (str/includes? json "\"proxied\" : false"))
    (is (not (str/includes? json "true")))))

(deftest dns-publishes-no-wildcard
  ;; The sources need one because they expose services through NetBird's own
  ;; reverse proxy. Traefik routes Authentik directly here, so nothing resolves
  ;; under a wildcard and publishing one would only widen the surface.
  (is (not (str/includes? (tools/dns-json (assoc (fixture) :ip "192.0.2.10")) "*"))))

(deftest inventory-keeps-one-target
  (let [inventory (tools/inventory (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? inventory "192.0.2.10"))
    (is (str/includes? inventory "netbird-fixture"))))

(deftest ansible-renders-the-whole-stack
  (let [targets (map #(str (:target %)) (tools/ansible-specs (fixture)))]
    (doseq [f ["ansible.cfg" "main.yml" "cleanup.yml" "compose.yml" "config.yaml"
               "dashboard.env" "blueprint.yaml" "bootstrap.sh" "smoke.sh"
               "s3.py" "backup.sh" "restore.sh" "status.sh" "backup.service"
               "backup-failure.service" "backup.timer" "inventory.json"]]
      (is (some #(str/ends-with? % f) targets) f))))

(deftest operator-secrets-reach-the-host-as-lookups-not-values
  ;; `.colors/` is generated output and the goldens are committed, so the
  ;; secret must never be the thing that lands on disk — the expression is.
  ;; The lookups live literally in the template rather than in the data map,
  ;; because Selmer HTML-escapes a value it interpolates and Ansible would
  ;; receive `&#39;` instead of a quote.
  (let [template (slurp (io/resource "io/github/getcolors/netbird/tools/ansible/main.yml"))]
    (doseq [par ["COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD"
                 "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD"
                 "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY"
                 "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID"
                 "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? template (str "lookup('env','" par "')")) par))))

(deftest the-data-map-carries-no-operator-secret
  (let [data (:data (spec-for (fixture) "main.yml"))]
    (is (= "netbird.example.com" (:netbird-host data)))
    (doseq [k [:netbird-bootstrap-password :netbird-authentik-bootstrap-password
               :netbird-backup-recovery-key :netbird-backup-r2-access-key-id
               :netbird-backup-r2-secret-access-key]]
      (is (nil? (get data k)) (str k)))))

(deftest generated-secrets-are-placeholders-in-the-rendered-config
  ;; The three server secrets are substituted on the host at install time, so
  ;; what `build` renders — and what a golden commits — is the placeholder.
  (let [template (slurp (io/resource "io/github/getcolors/netbird/tools/ansible/config.yaml"))]
    (doseq [ph ["__RELAY_AUTH_SECRET__" "__SESSION_COOKIE_ENCRYPTION_KEY__"
                "__DATASTORE_ENCRYPTION_KEY__"]]
      (is (str/includes? template ph) ph))))

(deftest a-delete-without-compute-skips-the-host-entirely
  ;; There is no machine to stop, and the cleanup play would only fail against
  ;; the placeholder address.
  (is (= 0 (:green/exit (tools/ansible-step (assoc (fixture) :green/event :delete))))))

(deftest acceptance-is-skipped-outside-a-real-create
  (doseq [event [:build :delete]]
    (is (= 0 (:green/exit (tools/acceptance-step (assoc (fixture) :green/event event)))))))

(deftest traefik-has-a-derived-fixed-address
  ;; netbird-server maps the Authentik hostname to it, so it cannot float. It
  ;; is derived rather than configured: a value that can only correctly be
  ;; `<subnet>.10` is a transcription step.
  (is (= "172.30.0.10" (validate/traefik-ip (fixture))))
  (is (= "10.9.0.10" (validate/traefik-ip (fixture :netbird-docker-subnet "10.9.0.0/24")))))

(deftest the-server-reaches-authentik-through-traefik
  ;; A container resolving the public name gets this host's own address and
  ;; dies in hairpin NAT; the issuer must stay the public URL, so the name is
  ;; pointed at the proxy instead.
  (let [compose (slurp (io/resource "io/github/getcolors/netbird/tools/ansible/compose.yml"))]
    (is (str/includes? compose "extra_hosts"))
    (is (str/includes? compose "<{ netbird-authentik-host }>:<{ traefik-ip }>"))))

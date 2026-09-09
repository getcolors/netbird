(ns io.github.getcolors.netbird.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.netbird.compute :as compute]
            [io.github.getcolors.netbird.ssh-config :as ssh-config]
            [io.github.getcolors.netbird.tools :as tools]
            [io.github.getcolors.netbird.validate :as validate]))

(def defaults {:provider-compute "vultr" :provider-dns "cloudflare"
               :provider-backend "r2" :compute-prevent-destroy true
               :workdir ".colors"})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts event)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          (fn [opts _ {:keys [event real?]}]
            (if (and real? (= :create event)) (ssh-config/preflight! (assoc opts :green/exit 0)) (assoc opts :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :netbird/start [start-step :netbird/load]
      :netbird/load [compute/load-step :netbird/ansible]
      :netbird/ansible [tools/ansible-step :netbird/dns]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its host is stale but harmless; a
      ;; key that predeceases its host locks the operator out of a machine that
      ;; still exists. Both orders are deliberate; see standards/ssh-config.md.
      :netbird/dns [tools/dns-step :netbird/ssh-config]
      :netbird/ssh-config [tools/ansible-local-step :netbird/infrastructure]
      :netbird/infrastructure [tools/infrastructure-step])
    (case step
      :netbird/start [start-step :netbird/infrastructure]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine.
      :netbird/infrastructure [tools/infrastructure-step :netbird/ssh-config]
      :netbird/ssh-config [tools/ansible-local-step :netbird/dns]
      ;; DNS before convergence: Traefik asks Let's Encrypt for a certificate
      ;; the moment it starts, and TLS-ALPN-01 only succeeds once the names
      ;; resolve to this host. The record existing is necessary but not
      ;; sufficient — the playbook additionally waits for public resolvers to
      ;; carry it before starting anything.
      :netbird/dns [tools/dns-step :netbird/ansible]
      :netbird/ansible [tools/ansible-step :netbird/acceptance]
      :netbird/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:netbird/infrastructure :netbird/dns :netbird/ssh-config
   :netbird/ansible :netbird/acceptance :netbird/load])

(def workflow
  (-> (wf/workflow {:start :netbird/start :wire-fn wire-fn})
      (wf/advice-add :netbird/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))

(ns io.github.getcolors.netbird.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.netbird.validate-test :refer [fixture]]
            [io.github.getcolors.netbird.workflow :as workflow]))

;; The compute state is read once per run, through `state-output`, on a real
;; create or delete. Every lifecycle test stubs it: nil is a readable state
;; holding no compute, a map is a recorded `params`, and a throw is a backend
;; that cannot be read.
(defn- start [opts state]
  (with-redefs [workflow/state-output (fn [_] state)]
    (workflow/start-step opts {})))

(defn- start-unreadable [opts]
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  (with-redefs [workflow/state-output (fn [_] (throw (ex-info "tofu output failed: no backend" {:dir "x"})))]
    (workflow/start-step opts {})))

(def credentials
  "What a real delete asks for: the providers and the final backup's set."
  {:vultr-api-key "v" :cloudflare-api-token "c"
   :netbird-backup-recovery-key "k"
   :netbird-backup-r2-access-key-id "a" :netbird-backup-r2-secret-access-key "s"})

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))

(deftest build-and-dry-run-never-touch-ssh-or-state
  ;; The standard forbids reading, creating, or requiring anything under ~/.ssh
  ;; on a build or dry-run: they render from desired state alone. Nor do they
  ;; read the backend: a throwing state read proves nothing on these paths
  ;; reaches it.
  (doseq [opts [(assoc (fixture) :green/event :build)
                (assoc (fixture) :green/event :create :green/dry-run true)
                (assoc (fixture) :green/event :delete :green/dry-run true)]]
    (let [result (start-unreadable opts)]
      (is (= 0 (:green/exit result)))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder")
          "a build must not name the operator's home directory"))))

(deftest real-create-requires-credentials
  (let [r (start (assoc (fixture) :green/event :create) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))
    (is (str/includes? (:green/err r) "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD"))))

(deftest real-delete-asks-for-the-providers-and-the-backup-set-only
  ;; The thunk handed to ONCE carries the event: a delete still never asks
  ;; for an account password.
  (let [r (start (assoc (fixture) :green/event :delete :compute-prevent-destroy false) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))
    (is (str/includes? (:green/err r) "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY"))
    (is (not (str/includes? (:green/err r) "BOOTSTRAP_PASSWORD")))))

(deftest delete-is-protected
  (let [r (start (assoc (fixture) :green/event :delete) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COMPUTE_PREVENT_DESTROY"))))

;; --- provider switching is a rebuild, never an apply

(deftest a-provider-switch-is-refused-on-create-and-delete
  (doseq [event [:create :delete]]
    (testing (str "Vultr selected, DigitalOcean recorded, on " (name event))
      (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                     {:provider "digitalocean" :ip "203.0.113.9"})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a digitalocean machine; set provider-compute back to digitalocean and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-is-accepted-on-the-default-provider
  ;; A deployment created before this package recorded a provider carries no
  ;; `params.provider`; it is a Vultr machine, and Vultr is what is selected.
  (doseq [event [:create :delete]]
    (let [r (start (assoc (fixture) :green/event event :compute-prevent-destroy false)
                   {:ip "203.0.113.9"})]
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc (fixture) :green/event :create) {:provider "vultr" :ip "203.0.113.9"})]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc (fixture) :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No state stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. Green's SDK shells out
  ;; to tofu in a directory that does not exist and reports that launch
  ;; failure as its own `tofu output failed:` step error, the way red and
  ;; blue always did; ONCE's `read-state` counts that as an unreadable state,
  ;; so the create reports its credentials instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "netbird-fresh"}))]
    (try
      (let [r (workflow/start-step (assoc (fixture) :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_VULTR_API_KEY"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest an-unreadable-backend-fails-a-real-delete-closed
  ;; Swallowing it is how a teardown ends up converging against 192.0.2.10.
  (let [r (start-unreadable (merge (fixture) credentials
                                   {:green/event :delete :compute-prevent-destroy false}))]
    (is (= 1 (:green/exit r)))
    (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
    (is (str/includes? (:green/err r) "no backend"))))

(deftest a-real-delete-adopts-the-recorded-address
  (let [r (start (merge (fixture) credentials {:green/event :delete :compute-prevent-destroy false})
                 {:provider "vultr" :ip "203.0.113.9" :user "root"})]
    (is (= 0 (:green/exit r)))
    (is (= "203.0.113.9" (:ip r))))
  ;; A readable state without compute leaves the address unset, and the
  ;; cleanup step skips itself.
  (let [r (start (merge (fixture) credentials {:green/event :delete :compute-prevent-destroy false})
                 nil)]
    (is (= 0 (:green/exit r)))
    (is (nil? (:ip r)))))

(deftest graph-orders-the-stack
  (is (= [:netbird/infrastructure]
         (vec (rest (workflow/wire-fn :netbird/start {:green/event :create})))))
  (is (= [:netbird/ssh-config]
         (vec (rest (workflow/wire-fn :netbird/infrastructure {:green/event :create})))))
  (is (= [:netbird/dns]
         (vec (rest (workflow/wire-fn :netbird/ssh-config {:green/event :create})))))
  ;; DNS before convergence: Traefik asks Let's Encrypt for a certificate as
  ;; soon as it starts, and TLS-ALPN-01 only succeeds once the names resolve.
  (is (= [:netbird/ansible]
         (vec (rest (workflow/wire-fn :netbird/dns {:green/event :create})))))
  (is (= [:netbird/acceptance]
         (vec (rest (workflow/wire-fn :netbird/ansible {:green/event :create}))))))

(deftest delete-removes-the-key-after-the-compute-destroy
  ;; The ordering is what makes "key present ⇔ deployment exists" hold: a
  ;; failed destroy never reaches the cleanup step, and correctly leaves the
  ;; key that is still the only credential to whatever survived.
  (is (= [:netbird/ansible]
         (vec (rest (workflow/wire-fn :netbird/start {:green/event :delete})))))
  (is (= [:netbird/ssh-cleanup]
         (vec (rest (workflow/wire-fn :netbird/infrastructure {:green/event :delete})))))
  (is (empty? (rest (workflow/wire-fn :netbird/ssh-cleanup {:green/event :delete})))))

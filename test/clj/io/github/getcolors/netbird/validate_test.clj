(ns io.github.getcolors.netbird.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.cli :as green-cli]
            [io.github.getcolors.netbird.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def optout-file "test/fixtures/optout.yml")

(defn- read-fixture [path overrides]
  (merge (green-cli/read-state path (str/replace (slurp path) "WORKDIR" ".colors"))
         overrides))
(defn fixture [& {:as overrides}] (read-fixture fixture-file overrides))
(defn optout [& {:as overrides}] (read-fixture optout-file overrides))

(deftest fixture-is-valid (is (= [] (validate/state-errors (fixture)))))
(deftest optout-fixture-is-valid (is (= [] (validate/state-errors (optout)))))

(deftest machine-key-is-not-required
  ;; The standard makes absence meaningful: requiring vultr-ssh-keys would make
  ;; every conforming deployment invalid.
  (is (not-any? #(str/includes? % "vultr-ssh-keys") (validate/state-errors (fixture)))))

(deftest absent-machine-key-selects-keygen
  (is (true? (validate/keygen? (fixture))))
  (is (false? (validate/keygen? (optout)))))

;; --- Compute Name Standard -------------------------------------------------

(deftest a-name-key-is-not-required
  ;; §1: a fresh colors.yml that omits it is complete.
  (is (not-any? #(str/includes? % "vultr-name") (validate/state-errors (fixture)))))

(deftest the-machine-is-named-after-the-profile
  (is (= "netbird-fixture" (validate/compute-name (fixture)))))

(deftest presence-is-the-only-switch
  ;; §2: absent, blank and REPLACE_ME all mean the profile; anything else is
  ;; the name.
  (doseq [v [nil "" "   " "REPLACE_ME"]]
    (is (= "netbird-fixture" (validate/compute-name (fixture :vultr-name v))) (pr-str v)))
  (is (= "custom-box" (validate/compute-name (fixture :vultr-name "custom-box")))))

(deftest the-override-is-validated-not-passed-through
  ;; §2: validate against the provider's naming rules rather than reading it
  ;; unread.
  (is (some #(str/includes? % "vultr-name")
            (validate/state-errors (fixture :vultr-name "not a valid label!"))))
  (is (= [] (validate/state-errors (fixture :vultr-name "netbird-box_1.a")))))

(deftest there-is-no-package-key
  ;; §5: a key that can hold exactly one value carries no information.
  (is (not-any? #(str/includes? % "package") (validate/state-errors (fixture))))
  (is (not (contains? (set validate/required) :package))))

;; --- desired state ---------------------------------------------------------

(deftest reports-all-errors
  (let [errors (validate/state-errors
                (fixture :netbird-host "bad"
                         :netbird-server-image "floating"
                         :netbird-letsencrypt-email "not-an-email"
                         :provider-dns "other" :provider-compute "digitalocean"
                         :netbird-backup-retention-days 0
                         :netbird-backup-dir "relative/path"
                         :netbird-stun-port 70000
                         :netbird-docker-subnet "nonsense"
                         :vultr-os-id "2284"))]
    (is (<= 9 (count errors)))
    (doseq [part ["host" "image" "letsencrypt-email" "provider-dns" "provider-compute"
                  "os-id" "retention-days" "backup-dir" "stun-port" "docker-subnet"]]
      (is (some #(str/includes? % part) errors) part))))

(deftest both-public-names-must-share-one-zone
  ;; The DNS stage looks a single zone up and creates both records in it, so a
  ;; second name outside that zone would render a record it cannot create.
  (is (some #(str/includes? % "share a zone")
            (validate/state-errors (fixture :netbird-authentik-host "authentik.elsewhere.net"))))
  (is (= [] (validate/state-errors (fixture :netbird-authentik-host "idp.example.com")))))

(deftest the-two-public-names-must-differ
  (is (some #(str/includes? % "must differ")
            (validate/state-errors (fixture :netbird-authentik-host "netbird.example.com")))))

(deftest the-two-identities-must-be-distinct
  ;; They live in different NetBird accounts — the local one created by
  ;; /api/setup, the federated one created by its first Authentik login — and
  ;; nothing merges them. One address for both would read as a single identity
  ;; that reaches both, which does not exist.
  (is (some #(str/includes? % "netbird-authentik-bootstrap-email")
            (validate/state-errors (fixture :netbird-bootstrap-email "admin@example.com")))))

(deftest there-is-no-owner-email-key
  ;; The owner of the account this deployment runs *is* the Authentik admin;
  ;; a second key whose only correct value is that address is a transcription
  ;; step, and transcription drifts.
  (is (not (contains? (set validate/required) :netbird-owner-email))))

(deftest accepts-a-digest-pin
  (is (= [] (validate/state-errors
             (fixture :netbird-traefik-image
                      (str "traefik@sha256:" (apply str (repeat 64 "a"))))))))

(deftest no-image-may-float
  (doseq [k validate/image-keys]
    (is (some #(str/includes? % "floating tag")
              (validate/state-errors (fixture k "netbirdio/netbird-server:latest")))
        (str k))))

(deftest an-untagged-image-is-refused
  ;; `repository/name` means :latest by implication and would walk past a
  ;; suffix-only check for ":latest".
  (is (some #(str/includes? % "explicit image tag")
            (validate/state-errors (fixture :netbird-server-image "netbirdio/netbird-server")))))

(deftest profile-overlay-is-refused
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))

;; --- credentials -----------------------------------------------------------

(deftest a-create-names-every-operator-secret
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :create))]
    (doseq [name ["COLORS_PAR_VULTR_API_KEY" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_NETBIRD_BOOTSTRAP_PASSWORD"
                  "COLORS_PAR_NETBIRD_AUTHENTIK_BOOTSTRAP_PASSWORD"
                  "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY"
                  "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID"
                  "COLORS_PAR_NETBIRD_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? errors name) name))
    ;; Generated on the host and supplied by nobody.
    (doseq [absent ["OIDC_CLIENT_SECRET" "RELAY" "SESSION" "ENCRYPTION_KEY"
                    "AUTHENTIK_SECRET_KEY" "PAT"]]
      (is (not (str/includes? errors absent)) absent))))

(deftest a-delete-does-not-ask-for-the-account-passwords
  ;; Destroying a machine must not require the credentials needed to converge
  ;; one; a missing owner password should not be a lock on the exit.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_VULTR_API_KEY"))
    (is (not (str/includes? errors "BOOTSTRAP_PASSWORD")))))

(deftest a-delete-still-asks-for-what-the-final-backup-needs
  ;; cleanup.yml takes a last archive on the way out, and a delete that cannot
  ;; back up is a delete that cannot be undone.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_NETBIRD_BACKUP_RECOVERY_KEY"))
    (is (str/includes? errors "COLORS_PAR_NETBIRD_BACKUP_R2_ACCESS_KEY_ID"))))

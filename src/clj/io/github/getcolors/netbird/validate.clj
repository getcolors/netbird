(ns io.github.getcolors.netbird.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.utils :as once-utils]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def required
  "Every key desired state must carry.

  Two deliberate absences. `vultr-ssh-keys` selects opt-out mode by being
  present, so requiring it would make every conforming keygen deployment
  invalid. `vultr-name` is the Compute Name Standard's optional override: a
  fresh colors.yml that omits it is complete and names the machine after the
  profile. There is likewise no `package` key — §5 removes a key that can hold
  exactly one value."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   :netbird-host :netbird-authentik-host :netbird-letsencrypt-email
   :netbird-owner-email :netbird-bootstrap-email :netbird-bootstrap-name
   :netbird-authentik-bootstrap-email
   :netbird-oidc-client-id :netbird-stun-port :netbird-log-level
   :netbird-docker-subnet
   :netbird-server-image :netbird-dashboard-image :netbird-traefik-image
   :netbird-client-image :netbird-authentik-image
   :netbird-authentik-postgres-image :netbird-authentik-redis-image
   :netbird-backup-dir :netbird-backup-r2-bucket :netbird-backup-r2-endpoint
   :netbird-backup-r2-region :netbird-backup-oncalendar
   :netbird-backup-retention-days
   :vultr-region :vultr-plan :vultr-os-id
   :vultr-ssh-sources :vultr-http-sources :vultr-stun-sources
   :r2-bucket :r2-endpoint])

(def image-keys
  [:netbird-server-image :netbird-dashboard-image :netbird-traefik-image
   :netbird-client-image :netbird-authentik-image
   :netbird-authentik-postgres-image :netbird-authentik-redis-image])

(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def email-re #"^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
;; An explicit tag or digest is mandatory. A bare `repository/name` means
;; `:latest` by implication and would walk straight past a suffix check for
;; ":latest", which is why the shape is required rather than the suffix denied.
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$")
(def abs-path-re #"^/[^\s]*$")
(def cidr-re #"^(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}$")
;; Vultr labels accept letters, digits, dashes, underscores and periods.
(def vultr-name-re #"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
(def client-id-re #"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn placeholder?
  "Absent, blank or REPLACE_ME all mean 'use the profile' (Compute Name
  Standard §2: presence is the only switch)."
  [v]
  (or (missing? v) (= "REPLACE_ME" (str/trim (str v)))))

(defn compute-name
  "What this deployment calls its machine. The one function that answers it —
  every label, including the firewall's, derives from this and never from the
  raw override key or a second copy of the profile (§3)."
  [opts]
  (let [override (:vultr-name opts)]
    (if (placeholder? override) (str (:profile opts)) (str/trim (str override)))))

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(defn traefik-ip
  "A fixed address for Traefik on the compose network, derived from the subnet
  rather than configured.

  It exists because of hairpin NAT. `netbird-server` must fetch the Authentik
  issuer's discovery document over its **public** URL — the issuer in a token
  has to match the one a browser used — but a container resolving that name
  gets the host's own public address, and the connection times out on the way
  back in. Mapping the name to Traefik's address on the shared network sends
  the request straight to the proxy, which still serves the real certificate
  for it, so TLS and the issuer string both stay honest.

  Derived, not a key: a value that can only correctly be `<subnet>.10` is a
  transcription step, and transcription drifts."
  [opts]
  (let [base (first (str/split (str (:netbird-docker-subnet opts)) #"/"))
        octets (str/split base #"\.")]
    (when (= 4 (count octets))
      (str/join "." (concat (take 3 octets) ["10"])))))

(defn zone
  "The Cloudflare zone both public names belong to."
  [opts]
  (once-utils/registrable-domain (:netbird-host opts)))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (when-not (= "vultr" (:provider-compute opts))
      [":provider-compute must be vultr"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (for [k [:netbird-host :netbird-authentik-host]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches host-re (str v))))]
      (str k " must be a fully qualified hostname"))
    ;; One zone lookup serves both records, so a second name outside it would
    ;; render a record the DNS stage cannot create.
    (when (and (not (missing? (:netbird-host opts)))
               (not (missing? (:netbird-authentik-host opts)))
               (not= (once-utils/registrable-domain (:netbird-host opts))
                     (once-utils/registrable-domain (:netbird-authentik-host opts))))
      [":netbird-authentik-host must share a zone with :netbird-host"])
    (when (= (str (:netbird-host opts)) (str (:netbird-authentik-host opts)))
      [":netbird-authentik-host must differ from :netbird-host"])
    (for [k [:netbird-letsencrypt-email :netbird-owner-email
             :netbird-bootstrap-email :netbird-authentik-bootstrap-email]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches email-re (str v))))]
      (str k " must be an email address"))
    ;; The break-glass administrator and the Authentik owner must be different
    ;; accounts. One address for both would make the recovery path depend on
    ;; the identity provider it exists to survive.
    (when (and (not (missing? (:netbird-owner-email opts)))
               (= (str (:netbird-owner-email opts)) (str (:netbird-bootstrap-email opts))))
      [":netbird-owner-email must differ from :netbird-bootstrap-email"])
    (for [k image-keys
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag or digest"))
    ;; This package owns its templates rather than following an upstream
    ;; installer, so nothing tells it when a floating tag moved underneath it.
    (for [k image-keys
          :let [v (str (get opts k))]
          :when (or (str/ends-with? v ":latest") (str/ends-with? v ":main"))]
      (str k " must not track a floating tag; pin the version"))
    (when-not (or (missing? (:netbird-oidc-client-id opts))
                  (re-matches client-id-re (str (:netbird-oidc-client-id opts))))
      [":netbird-oidc-client-id must be 3-64 characters of letters, digits, dot, dash or underscore"])
    (when-not (or (missing? (:netbird-stun-port opts))
                  (and (integer? (:netbird-stun-port opts))
                       (< 0 (:netbird-stun-port opts) 65536)))
      [":netbird-stun-port must be a port number"])
    (when-not (or (missing? (:netbird-docker-subnet opts))
                  (re-matches cidr-re (str (:netbird-docker-subnet opts))))
      [":netbird-docker-subnet must be a CIDR block"])
    (when-not (or (missing? (:netbird-log-level opts))
                  (contains? #{"error" "warn" "info" "debug"} (str (:netbird-log-level opts))))
      [":netbird-log-level must be error, warn, info, or debug"])
    (when-not (or (missing? (:netbird-backup-dir opts))
                  (re-matches abs-path-re (str (:netbird-backup-dir opts))))
      [":netbird-backup-dir must be an absolute path"])
    (when-not (or (missing? (:netbird-backup-retention-days opts))
                  (and (integer? (:netbird-backup-retention-days opts))
                       (pos? (:netbird-backup-retention-days opts))))
      [":netbird-backup-retention-days must be a positive integer"])
    (when-not (or (missing? (:vultr-os-id opts)) (integer? (:vultr-os-id opts)))
      [":vultr-os-id must be Vultr's numeric operating-system id"])
    ;; The override is validated against the provider's rules rather than
    ;; passed through unread (Compute Name Standard §2).
    (when-not (or (placeholder? (:vultr-name opts))
                  (re-matches vultr-name-re (str/trim (str (:vultr-name opts)))))
      [":vultr-name must be letters, digits, dot, dash or underscore"]))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(def provider-secrets
  "What talking to the providers needs, on any real event."
  [:vultr-api-key :cloudflare-api-token])

(def application-secrets
  "What converging the machine needs, and therefore only a create.

  Everything else this deployment holds is generated on the host and never
  supplied: the relay secret, the session cookie key, the store encryption key,
  Authentik's SECRET_KEY and database password, the OIDC client secret, and the
  durable automation credential. The recovery key is the one exception — it is
  operator-supplied precisely because a key generated on the server would be
  lost with the server it protects."
  [:netbird-bootstrap-password
   :netbird-authentik-bootstrap-password
   :netbird-backup-recovery-key
   :netbird-backup-r2-access-key-id
   :netbird-backup-r2-secret-access-key])

(defn secret-errors
  "Credentials a real event needs. A delete tears down infrastructure; it asks
  for the provider credentials plus the backup pair, because `cleanup.yml`
  takes a final archive on the way out and a delete that cannot back up is a
  delete that cannot be undone. It never asks for the bootstrap passwords —
  demanding the owner's password to destroy a machine would just be a lock on
  the exit."
  [opts event]
  (let [keys (concat provider-secrets
                     (case event
                       :create application-secrets
                       :delete [:netbird-backup-recovery-key
                                :netbird-backup-r2-access-key-id
                                :netbird-backup-r2-secret-access-key]
                       [])
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:vultr-api-key "VULTR_API_KEY"}
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))

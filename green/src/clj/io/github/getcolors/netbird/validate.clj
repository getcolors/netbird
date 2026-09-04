(ns io.github.getcolors.netbird.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.utils :as once-utils]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are the non-secret keys that provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, and `:tofu-env` the
  subset OpenTofu reads from the process environment itself. Keeping the three
  together is what stops a provider being validated against one set of keys and
  run with another — a stage exporting a credential nobody checked for, or a
  check demanding a key no template uses. The keys of this map are the
  advertised providers; a provider without a template directory and a golden
  is not advertised, and this package advertises one.

  Two keys the template reads are deliberately not required. `vultr-name` is
  an optional override of the profile (Compute Name Standard), and
  `vultr-ssh-keys` is meaningful by its absence (SSH Keypair Standard). The
  third source list, `vultr-stun-sources`, is this package's extension of the
  standard's two: STUN is the one UDP port it publishes."
  {"vultr"
   {:required [:vultr-region :vultr-plan :vultr-os-id
               :vultr-ssh-sources :vultr-http-sources :vultr-stun-sources]
    :secrets [:vultr-api-key]
    :tofu-env {:vultr-api-key "VULTR_API_KEY"}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered."
  "vultr")

(def spec
  "How this package describes itself to ONCE's `compute`, the Compute Provider
  Standard's operations over a package-owned registry. The registry and the
  default are the data above; `:sources` names the firewall lists the template
  reads — SSH must list at least one CIDR; an empty HTTP list means no public
  HTTP and an empty STUN list no public STUN. The name rules are ONCE's."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources"] :may-be-empty ["http-sources" "stun-sources"]}})

(def required
  "Every key desired state must carry whichever provider is selected. The
  provider-scoped keys come from `compute-providers`.

  There is no `package` key — Compute Name Standard §5 removes a key that can
  hold exactly one value."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   :netbird-host :netbird-authentik-host :netbird-letsencrypt-email
   :netbird-bootstrap-email :netbird-bootstrap-name
   :netbird-authentik-bootstrap-email
   :netbird-oidc-client-id :netbird-stun-port :netbird-log-level
   :netbird-docker-subnet
   :netbird-server-image :netbird-dashboard-image :netbird-traefik-image
   :netbird-client-image :netbird-authentik-image
   :netbird-authentik-postgres-image :netbird-authentik-redis-image
   :netbird-backup-dir :netbird-backup-r2-bucket :netbird-backup-r2-endpoint
   :netbird-backup-r2-region :netbird-backup-oncalendar
   :netbird-backup-retention-days
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
;; The compose bridge subnet is a package key, not a firewall source, so its
;; shape is this package's to check.
(def cidr-re #"^(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}$")
(def client-id-re #"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(def compute-key
  "`:<provider>-<suffix>`: desired state names compute keys after the
  provider, so the shared steps reach them through the selected provider
  rather than a fixed prefix. ONCE's; named here so `tools` reads the same."
  compute/key)

(def compute-name
  "What this deployment calls its machine: `vultr-name` when present and not a
  placeholder, else the profile (Compute Name Standard). ONCE's; every label,
  including the firewall's, derives from this one answer and never from the
  raw override key or a second copy of the profile (§3)."
  compute/name)

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(def cidrs
  "A source list as desired state or an overlay string carries it. ONCE's, so
  the validator and the template can never disagree about what an entry is."
  compute/cidrs)

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

(defn state-errors
  "Every problem with desired state at once: the missing keys (this package's
  and the selected provider's), the package's own checks, then the Compute
  Provider Standard's — selection, the network contract over all three source
  lists, and the provider rules including the resolved machine name — which
  are ONCE's over `spec`."
  [opts]
  (vec
   (concat
    (for [k (concat required (compute/required-keys spec opts))
          :when (missing? (get opts k))]
      (str k " is required"))
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
    (for [k [:netbird-letsencrypt-email
             :netbird-bootstrap-email :netbird-authentik-bootstrap-email]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches email-re (str v))))]
      (str k " must be an email address"))
    ;; The two identities live in different NetBird accounts — the local one
    ;; created by /api/setup, the federated one created by its first Authentik
    ;; login — and there is no merge between them. One address for both would
    ;; read as a single identity that can reach both, which nothing provides.
    (when (and (not (missing? (:netbird-authentik-bootstrap-email opts)))
               (= (str (:netbird-authentik-bootstrap-email opts))
                  (str (:netbird-bootstrap-email opts))))
      [":netbird-authentik-bootstrap-email must differ from :netbird-bootstrap-email"])
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
    (compute/state-errors spec opts))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(defn provider-secrets
  "What talking to the providers needs, on any real event: the selected
  compute provider's credential, from the registry, and Cloudflare's."
  [opts]
  (concat (compute/secrets spec opts) [:cloudflare-api-token]))

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
  (let [keys (concat (provider-secrets opts)
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
    :provider-compute (compute/tofu-env spec opts)
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))

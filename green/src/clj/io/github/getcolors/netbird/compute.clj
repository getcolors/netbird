(ns io.github.getcolors.netbird.compute
 (:require [cheshire.core :as json] [clojure.java.io :as io] [clojure.string :as str]
           [green.cli :as cli] [io.github.getcolors.compute :as library]
           [io.github.getcolors.compute-deployment-request :as deployment]
           [io.github.getcolors.compute-planning :as planning]
           [io.github.getcolors.compute-orchestration :as orchestration]
           [io.github.getcolors.compute-inspection :as inspection]))
(def topology [{:count 1}])
(defn requirements [opts]
 (let [ssh (deployment/source-cidrs opts "ssh-sources" "netbird-ssh-sources") http (deployment/source-cidrs opts "http-sources" "netbird-http-sources") stun (deployment/source-cidrs opts "stun-sources" "netbird-stun-sources")]
  (when (empty? ssh) (throw (ex-info "SSH source list must not be empty" {})))
  {:single_host true :ipv6 false :security {:egress "all" :private_filter false
   :ingress (into [{:id "ssh" :protocol "tcp" :from_port 22 :to_port 22 :sources ssh}
             {:id "stun" :protocol "udp" :from_port (:netbird-stun-port opts) :to_port (:netbird-stun-port opts) :sources stun}]
                  (map (fn [port] {:id (str "web-" port) :protocol "tcp" :from_port port :to_port port :sources http}) [80 443]))}
   :legacy_state_keys [(str (:profile opts) "/netbird-infrastructure.tfstate")]}))
(defn errors [opts] (try (let [errors (library/validate opts)] (if (seq errors) errors (do (planning/plan-deployment opts topology (requirements opts)) []))) (catch Exception _ ["invalid singleton compute requirements"])))
(defn attach [opts result]
 (cond
  (not (contains? #{"planned" "ready" "present" "destroyed"} (:status result))) (assoc opts :green/exit 1 :green/err (if (seq (:errors result)) (str/join "\n" (:errors result)) "compute lifecycle refused"))
  (= "destroyed" (:status result)) (assoc opts :green/exit 0 :netbird/already-destroyed true)
  :else (let [cluster (:cluster result) node (first (filter #(= (:node_id %) (:entry_node_id cluster)) (:nodes cluster)))]
    (merge opts node {:green/exit 0 :colors-compute/cluster cluster :colors-compute/key (:key result) :ssh-private-key-path (or (get-in result [:key :private_key_path]) (:ssh_identity_file node))}))))
(defn- compute-json [value indent]
  (let [padding #(apply str (repeat % " "))]
    (cond
      (map? value) (if (empty? value) "{}"
                      (str "{\n" (str/join ",\n" (for [[key item] (sort-by key value)]
                                                       (str (padding (+ indent 2)) (json/generate-string key) ": " (compute-json item (+ indent 2)))))
                           "\n" (padding indent) "}"))
      (sequential? value) (if (empty? value) "[]"
                              (str "[\n" (str/join ",\n" (map #(str (padding (+ indent 2)) (compute-json % (+ indent 2))) value)) "\n" (padding indent) "]"))
      :else (json/generate-string value))))


(defn infrastructure-step [opts]
 (let [planning? (or (= :build (:green/event opts)) (:green/dry-run opts))
       result (if planning? (planning/plan-deployment opts topology (requirements opts)) (orchestration/orchestrate opts topology (requirements opts)))]
  (when planning?
   (doseq [[stage docs] (cons ["shared" (get-in result [:documents :shared])] (map (fn [[id docs]] [(str "nodes/" (name id)) docs]) (get-in result [:documents :nodes])))
           :let [key (if (= stage "shared") (get-in result [:state_keys :shared]) (get-in result [:state_keys :nodes (last (str/split stage #"/"))]))
                 docs (assoc docs "backend.tf.json" (:config (library/backend-plan opts key)))]
           [filename document] docs]
    (let [target (io/file (cli/stage-dir opts "compute") stage (name filename))]
     (io/make-parents target)
     (spit target (str (compute-json (json/parse-string (json/generate-string document)) 0) "\n")))))
  (attach opts result)))
(defn load-step [opts] (if (:green/dry-run opts) opts (attach opts (inspection/read-deployment opts (into {} (System/getenv)) {} (requirements opts)))))

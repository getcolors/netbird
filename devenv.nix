{ pkgs, ... }:
{
  languages.clojure.enable = true;
  languages.opentofu.enable = true;
  packages = with pkgs; [
    ansible babashka bun curl doctl jq openssh unzip uv wireguard-tools
    openjdk21 netcat-openbsd
  ];
}

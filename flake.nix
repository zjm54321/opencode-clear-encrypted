{
  description = "OpenCode clear-encrypted plugin";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.runCommand "${manifest.name}-${manifest.version}" {
          pname = manifest.name;
          version = manifest.version;
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let
                relative = pkgs.lib.removePrefix (toString ./. + "/") (toString path);
              in
              (type == "directory" && relative == "src")
              || (type == "regular" && builtins.elem relative [
                "src/index.ts"
                "src/tui.ts"
                "src/rpc.ts"
                "src/helper.ts"
                "LICENSE"
                "README.md"
              ]);
          };
          meta = {
            description = manifest.description;
            license = pkgs.lib.licenses.gpl3Plus;
            platforms = systems;
          };
        } ''
          mkdir -p "$out"
          for file in index tui rpc helper; do
            cp "$src/src/$file.ts" "$out/$file.ts"
          done
          cp "$src/LICENSE" "$out/LICENSE"
          if [ -f "$src/README.md" ]; then
            cp "$src/README.md" "$out/README.md"
          fi
          ln -s ${pkgs.lib.getExe pkgs.bun} "$out/bun"
        '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.nodejs ];
        };
      });
    };
}

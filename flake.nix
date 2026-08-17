{
  description = "AGMATH 开发环境（nix develop）";

  inputs = {
    # 开发环境基于 nixpkgs unstable，工具版本较新
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "agmath-dev";

            # 基础工具。需要新工具或库时，可以自行在此按需添加，
            # 例如 `pkgs.ripgrep`、`pkgs.python312`、`pkgs.nodejs`，
            # 然后重新执行 `nix develop` 即可生效。
            packages = with pkgs; [
              git
              curl
              jq
              # 算法侧车（ADR-001）：pyBKT 需 python3 + C++ 编译（venv 内 pip 安装）
              python312
              gcc
            ];

            # numpy/pyBKT 等 C 扩展依赖 libstdc++/libz 可加载
            # （侧车 .venv 由 sidecars/pybkt/setup.sh 创建）
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
              pkgs.stdenv.cc.cc.lib
              pkgs.zlib
            ];
          };
        });
    };
}

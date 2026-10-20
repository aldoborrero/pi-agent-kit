{
  pkgs,
}:
pkgs.mkShellNoCC {
  packages = [
    pkgs.bun
    pkgs.datasette
    pkgs.python3
    pkgs.sqlite
    pkgs.sqlite-web
  ];
  shellHook = ''
    export PRJ_ROOT=$PWD
    # Native mic capture (@oh-my-pi/pi-natives / cpal) dlopen()s its audio
    # backends at runtime; on NixOS they are not on the global loader path,
    # so point LD_LIBRARY_PATH at them explicitly.
    export LD_LIBRARY_PATH="${pkgs.alsa-lib}/lib:${pkgs.libpulseaudio}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  '';
}

#!/usr/bin/env python3
"""
install_sdk.py — Helper to install or unpack E.Sun SDK in Docker container
"""

import glob
import os
import subprocess
import sys
import sysconfig
import zipfile

def install_esun_sdk() -> None:
    wheels = glob.glob("esun_trade*.whl")
    linux_whl = next((w for w in wheels if "linux" in w.lower() or "manylinux" in w.lower()), None)
    installed = False

    if linux_whl:
        pep427 = "esun_trade-2.2.0-cp37-abi3-manylinux_2_17_x86_64.whl"
        if linux_whl != pep427:
            if os.path.exists(pep427):
                os.remove(pep427)
            os.rename(linux_whl, pep427)
            linux_whl = pep427
        print(f"Installing Linux wheel: {linux_whl}...")
        res = subprocess.run([sys.executable, "-m", "pip", "install", "--no-cache-dir", linux_whl])
        if res.returncode == 0:
            installed = True

    if not installed:
        for w in wheels:
            print(f"Attempting wheel install: {w}...")
            res = subprocess.run([sys.executable, "-m", "pip", "install", "--no-cache-dir", w])
            if res.returncode == 0:
                installed = True
                break

    if not installed and wheels:
        print("Extracting pure-python modules into site-packages...")
        target = sysconfig.get_paths()["purelib"]
        with zipfile.ZipFile(wheels[0]) as z:
            for item in z.namelist():
                if item.startswith("esun_trade"):
                    z.extract(item, target)
        print("Extracted esun_trade package to site-packages")

if __name__ == "__main__":
    install_esun_sdk()

# Packaging the ERP System (Windows installer)

This folder holds the [Inno Setup](https://jrsoftware.org/) script that turns
the built application into a single `Setup.exe` Windows installer.

## How the build works

```
frontend_src/  --(vite build)-->      static/
launcher.py + backend/ + static/  --(PyInstaller, ERP.spec)-->  dist/ERP System/
dist/ERP System/  --(Inno Setup, ERP-System.iss)-->  installer/Output/ERP-System-Setup-2.0.0.exe
```

* **PyInstaller** (`../ERP.spec`) produces a *one-folder* build:
  `dist/ERP System/ERP System.exe` plus an `_internal/` payload.
* **Inno Setup** (`ERP-System.iss`) wraps that folder into a normal installer
  with Start-Menu / desktop shortcuts and an uninstaller.

## Quick build (recommended)

From the repository root, in PowerShell:

```powershell
.\build.ps1
```

That runs all three stages and prints the path of the finished installer.

## Manual build

```powershell
# 1. Frontend  ->  static\
cd frontend_src
npm install          # first time only
npm run build
cd ..

# 2. Executable  ->  dist\ERP System\
python -m PyInstaller --noconfirm ERP.spec

# 3. Installer  ->  installer\Output\
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\ERP-System.iss
```

## Prerequisites (install once)

| Tool        | Install |
|-------------|---------|
| Node.js     | https://nodejs.org |
| PyInstaller | `pip install pyinstaller` |
| Inno Setup 6| https://jrsoftware.org/isdl.php |

## Notes

* **User data** (`erp.db`, backups, logs, `.secret_key`) is stored in
  `%APPDATA%\ERP System\`, never inside `Program Files`. It is **not** removed
  on uninstall, so data survives upgrades.
* The app serves on port **8765** and binds `0.0.0.0` for office-LAN access;
  the installer adds a private/domain Windows Firewall rule for it.
* Bump the version in **both** `ERP-System.iss` (`MyAppVersion`) and
  `backend/main.py` when releasing. Keep `AppId` in the `.iss` unchanged.
* To give the app/installer a custom icon, add `installer\erp.ico`, uncomment
  `SetupIconFile` in the `.iss`, and add `icon='installer/erp.ico'` to the
  `EXE(...)` call in `ERP.spec`.

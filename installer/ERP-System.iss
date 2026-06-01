; ════════════════════════════════════════════════════════════════════════════
;  ERP System — Inno Setup installer script
;
;  Build chain:   Vite (frontend)  ->  PyInstaller (ERP.spec)  ->  this script
;  Compile:       "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" ERP-System.iss
;                 (or run ..\build.ps1 which performs the whole chain)
;  Output:        installer\Output\ERP-System-Setup-<version>.exe
;
;  Prerequisite:  the PyInstaller folder  ..\dist\ERP System\  must already
;                 exist before compiling this script.
; ════════════════════════════════════════════════════════════════════════════

#define MyAppName      "ERP System"
#define MyAppVersion   "2.1.0"
#define MyAppPublisher "Ali Koteich"
#define MyAppExeName   "ERP System.exe"
; PyInstaller one-folder output, relative to this .iss file (installer\ -> repo root)
#define MyBuildDir     "..\dist\ERP System"

[Setup]
; Keep AppId FIXED forever — Windows uses it to recognise upgrades vs. new installs.
AppId={{8F2A5C3D-1E4B-4A9F-9C7D-3B6E8A1F2D40}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=Output
OutputBaseFilename=ERP-System-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
MinVersion=10.0
; The bundled app is 64-bit. (Inno Setup 6.3+ may use x64compatible instead of x64.)
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
; Installing into Program Files requires administrator rights.
PrivilegesRequired=admin
; Automatically close the app if it is running during an install / upgrade.
CloseApplications=yes
RestartApplications=no
; SetupIconFile=erp.ico        ; optional: drop an icon at installer\erp.ico and uncomment

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Ship the whole PyInstaller folder — the .exe plus its _internal\ payload
; (bundled Python runtime, the backend\ source and the static\ frontend).
Source: "{#MyBuildDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}";           Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}";     Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Allow office computers on the LAN to reach the server (it binds 0.0.0.0:8765).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""ERP System"" dir=in action=allow program=""{app}\{#MyAppExeName}"" enable=yes profile=private,domain"; Flags: runhidden; StatusMsg: "Configuring Windows Firewall for LAN access..."
; Offer to launch the app when the wizard finishes.
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Remove the firewall rule on uninstall.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""ERP System"""; Flags: runhidden; RunOnceId: "DelErpFirewallRule"

; ── Note on user data ───────────────────────────────────────────────────────
; The database, backups, logs and signing key live in:
;     %APPDATA%\ERP System\
; That folder is intentionally NOT removed on uninstall, so business data
; survives upgrades and re-installs. Delete it by hand for a full wipe.
;
; ── Note on the seeded database ─────────────────────────────────────────────
; The installer ships the current database as a read-only template bundled
; inside the PyInstaller payload (_internal\default.db). On the FIRST run only,
; launcher.py copies it to %APPDATA%\ERP System\erp.db so a fresh install opens
; with real data instead of an empty schema. Later runs keep the live DB.

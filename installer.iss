[Setup]
AppName=ERP System
AppVersion=1.0.0
AppPublisher=Your Company Name
AppPublisherURL=https://yourwebsite.com
DefaultDirName={autopf}\ERP System
DefaultGroupName=ERP System
OutputDir=installer_output
OutputBaseFilename=ERP-System-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Require admin rights so it can install to Program Files
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
; Include everything PyInstaller produced
Source: "dist\ERP System\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Start Menu shortcut
Name: "{group}\ERP System"; Filename: "{app}\ERP System.exe"
; Desktop shortcut (only if user chose the task above)
Name: "{commondesktop}\ERP System"; Filename: "{app}\ERP System.exe"; Tasks: desktopicon

[Run]
; Optionally launch the app after install finishes
Filename: "{app}\ERP System.exe"; Description: "Launch ERP System"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up the database and logs on uninstall (optional - remove these lines if client data should survive)
Type: files; Name: "{app}\startup_log.txt"
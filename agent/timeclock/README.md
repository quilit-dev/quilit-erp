# Quilit time-clock agent

This small program reads a ZKTeco fingerprint terminal on your office network
and sends the punches to your Quilit ERP. Once it is running, staff check in and
out on the terminal and their attendance appears in the ERP on its own.

It is needed because the terminal talks only to devices on the same network as
itself. Your ERP is on the internet, so something inside the office has to do
the fetching. That is all this is.

---

## What you need

- The fingerprint terminal, plugged into your network, with an IP address that
  does not change.
- A PC in the office that stays switched on. It does not need to be powerful —
  any machine that is already left on will do.
- Python 3.9 or newer on that PC (<https://python.org/downloads> — tick
  **"Add Python to PATH"** during install).

---

## Setting it up

There are two ways in. Pick the first one unless you are a developer.

### The office PC (no Python, one double-click)

You were sent **QuilitTimeClock.zip**. Everything is inside it.

**1. Get a token from the ERP.**
Sign in and go to **HR → Time clock → Devices → Add device**. Give it a name
you will recognise ("Front door"). The ERP shows the token **once** — leave that
screen open until step 3, or you will have to press **Rotate token** and start
again.

**2. Unzip it and double-click `Setup.cmd`.**
Right-click the ZIP → **Extract All** first. Running it from inside the ZIP
gives Windows a read-only temporary folder and the install fails halfway.

Windows asks for permission once. That is for the scheduled task; nothing else
needs it.

**3. Answer the questions.**
Every one has the usual answer already filled in — press Enter to accept it.
Only two need you: the terminal's IP address (on the device, **Menu → Comm →
Ethernet**) and the token from step 1. The token is hidden as you paste it;
right-click pastes into that window.

**4. Read the last screen.**
Setup proves the ERP accepts the token, then proves the terminal answers, and
only then schedules anything. If either check fails it stops and says which one
— nothing is left half-installed, and no task is registered. Fix the setting it
names and double-click `Setup.cmd` again.

Everything lands in `C:\Quilit\TimeClock`. To remove it later, double-click
`Uninstall.cmd`; that stops the collector and leaves the folder, the log and
the punches already in the ERP alone.

### A machine that has Python (developers)

```
pip install -r requirements.txt
copy config.example.ini config.ini      # then edit it
python agent.py --check                 # ERP accepts the token?
python agent.py --dry-run               # terminal answers? sends nothing
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

`install-task.ps1` is the Python equivalent of `install-agent.ps1` — same
scheduled task, pointed at `python agent.py` instead of the exe.

---

## Telling whether it is working

The ERP shows **Last seen** for each device under **HR → Time clock**. If that
stops updating, the agent has stopped and nobody is collecting punches.

**Watch that date.** A time clock that quietly stops is worse than one that never
worked, because the first sign of trouble is a payroll built on missing days. The
ERP will warn you on the Attendance screen if a device has not been heard from in
24 hours.

There is also a log beside the program, `agent.log`, which records every cycle.

---

## When something is wrong

**"The ERP rejected this device token."**
The token was revoked or rotated. Go to **HR → Time clock → Devices**, use
**Rotate token**, and paste the new one into `config.ini`.

**The agent cannot find the terminal.**
Check the IP address in `config.ini` matches the one on the device
(**Menu → Comm → Ethernet**), and that the PC can reach it:
`ping 192.168.1.201`. If the router gave the terminal a new address, set a
fixed one or a DHCP reservation — otherwise this will keep happening.

**Punches are being "refused".**
The log says how many. This nearly always means the terminal's own clock is
wrong — check the date and time on the device itself. Note that these terminals
do **not** adjust for daylight saving on their own, so they run an hour out
twice a year until somebody changes them.

**The office internet was down / the PC was off.**
Nothing is lost. The punches stay in the terminal's memory, and the agent sends
everything the next time it runs.

---

## Two things never to do

**Never clear the attendance log on the terminal.** It is the only copy of the
raw record. If somebody clears it, whatever had not yet reached the ERP is gone
for good.

**Never share `config.ini`.** The token in it can write attendance into your
ERP. If the PC is lost or stolen, revoke that device in **HR → Time clock**
straight away — it takes effect immediately.

---

## For whoever maintains this

```
python agent.py --once          one cycle and exit
python agent.py --dry-run       read and print, send nothing
python agent.py --check         verify the token, report clock skew
python agent.py --replay f.json send a recorded dump, no device needed
python agent.py -v              debug logging
```

### Building what you send a customer

```
powershell -ExecutionPolicy Bypass -File build-release.ps1
# -> release/QuilitTimeClock.zip   (~15 MB: exe + Setup.cmd + Uninstall.cmd
#                                   + install-agent.ps1 + README.md)
```

Windows only — a PyInstaller build is not cross-platform. The script runs
PyInstaller, smoke-tests the binary by making it print its own help (which
exercises the whole frozen import graph, so a missing `hiddenimport` dies on
the build machine rather than at a customer's first punch), assembles the
folder and zips it.

It **refuses to build** if `config.ini`, `agent.log` or `state.json` would
reach the release folder. The first holds a live device token and would hand
one customer another's credential — and would also silently skip the setup
questions on their PC, which is the kind of failure nobody notices until the
punches are going to the wrong workspace.

Send the ZIP and the device token **separately**. The token is shown once on
the customer's own screen; the best delivery is to have them read it off it.

Onefile on purpose: whoever installs this copies one thing into one folder. The
agent finds `config.ini`, `state.json` and `agent.log` beside the EXE, not
inside PyInstaller's temp folder — see `_here()`, which is the difference
between working in development and working on a customer's PC.

`state.json` holds the highest punch time successfully delivered. **Deleting it
is safe** — the agent will re-send everything on the device and the ERP will
recognise the duplicates and ignore them. The cursor is a bandwidth
optimisation, not the thing that stops double-counting; that is a uniqueness
constraint on the server.

Every cycle deliberately re-sends the last two days on top of whatever is new,
so a punch written while a cycle was in flight is never skipped.

This folder is not part of the ERP deployment and never ships in its container.
`pyzk` belongs here and must not be added to the backend's requirements.

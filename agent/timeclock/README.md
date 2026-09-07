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

**1. Get a token from the ERP.**
Sign in and go to **HR → Time clock → Devices → Add device**. Give it a name you
will recognise ("Front door"). The ERP shows you a token **once**. Copy the whole
block it offers.

**2. Put the files on the office PC.**
Copy this whole folder somewhere sensible, for example `C:\quilit-timeclock`.

**3. Create the configuration.**
Copy `config.example.ini` to `config.ini`, open it in Notepad, and fill in the
device's IP address and the token you just copied. The example file explains
every line.

**4. Install what it needs.** In a command prompt, in that folder:

```
pip install -r requirements.txt
```

**5. Check it works.**

```
python agent.py --check
```

This confirms the ERP accepts your token. Then:

```
python agent.py --dry-run
```

This reads the terminal and prints what it *would* send, without sending
anything. If you see punches listed, everything is wired up.

**6. Make it run by itself.** In an **Administrator** command prompt:

```
powershell -ExecutionPolicy Bypass -File install-task.ps1
```

That registers a Windows scheduled task which starts the agent when the PC boots
and keeps it running. To check on it later, open Task Scheduler and look for
**QuilitTimeClock**.

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

`state.json` holds the highest punch time successfully delivered. **Deleting it
is safe** — the agent will re-send everything on the device and the ERP will
recognise the duplicates and ignore them. The cursor is a bandwidth
optimisation, not the thing that stops double-counting; that is a uniqueness
constraint on the server.

Every cycle deliberately re-sends the last two days on top of whatever is new,
so a punch written while a cycle was in flight is never skipped.

This folder is not part of the ERP deployment and never ships in its container.
`pyzk` belongs here and must not be added to the backend's requirements.

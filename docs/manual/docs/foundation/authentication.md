# Authentication

How users prove they are who they say they are, and how the system tracks
their session afterwards.

## Purpose

Authentication is **the front door**. It produces a session that every
subsequent request validates against. The session also carries the user's
role, which is what every permission check uses.

## Personas

| Persona | What they care about |
|---|---|
| **Operator** | "Log in once a day, stay logged in, change my password without bothering IT." |
| **Administrator** | "Force password resets, kill stolen sessions, set sane lockout thresholds." |
| **Auditor** | "Prove who logged in when, from which IP, and that revoked sessions are honoured." |

## Quick reference

- Signed in for up to 24 hours, and signed out after 30 minutes of doing
  nothing
- Passwords are stored scrambled — nobody, including your provider, can
  read them
- New users are asked to choose their own password the first time they
  sign in

---

=== "Operator's view"

    ### Logging in

    1. Open the ERP URL the administrator gave you (e.g. `http://192.168.1.50:8765/`).
    2. Enter your username and password.
    3. If your account was just created, you'll be redirected to **Change
       Password** before you can do anything else — pick something only you
       know.
    4. You're in. Your name shows in the top right; the sidebar reflects what
       your role can see.

    ### Staying logged in

    A sign-in lasts up to 24 hours. As long as you do something once every
    30 minutes it keeps going; leave it longer and your next click takes you
    back to the sign-in page.

    ### Changing your password

    Top right menu → **Profile** → **Change password**.
    Requirements: 8+ characters, mixed case, at least one digit.

    ### "I'm locked out"

    After several failed attempts from the same IP, that IP is rate-limited
    for a few minutes (per the login attempts table). Wait a few minutes
    and try again, or ask the administrator to clear the limiter from the
    Admin Panel.

=== "Administrator's view"

    ### Forcing a password change

    Users → pick a user → **Force change password**. Next login will redirect
    them through the change-password screen. The old password remains valid
    *until* they successfully change it (so a help-desk reset call doesn't
    leave them locked out mid-shift).

    ### Killing a session

    Users → pick a user → **Active sessions** → **Revoke**. They are signed
    out immediately. Useful if a laptop is lost or a contractor leaves.

    ### How long sign-ins last

    24 hours, with a 30-minute idle cut-off. Your provider can shorten
    either — tighter for sensitive sites, looser for a shop-floor terminal
    somebody uses all day.

=== "Auditor's view"

    ### What's recorded

    | Where | What it holds |
    |---|---|
    | Users | Last sign-in, whether the account is active, its role |
    | Sessions | Each sign-in with its address, browser, start, last activity and expiry, and whether it was revoked |
    | Audit trail | Every sign-in and sign-out, plus every action taken afterwards |
    | Failed attempts | Wrong passwords, with address and time |

    ### Independent verification

    To answer "who was logged in at 14:32 on 2026-05-30?".

    To prove forced password changes were performed.

    ### Controls in place

    - Passwords are stored scrambled in a way that is deliberately slow to
      attack, and cannot be read back.
    - Repeated wrong passwords from one place are throttled.
    - Any sign-in can be revoked by an administrator.
    - New users must choose their own password the first time they sign in,
      including the very first administrator account.

---

## Things that are deliberately NOT supported

- Signing in with a Google or Microsoft account.
- A second code by phone or app on top of the password. Ask your provider
  if you need it.
- Signing in from a script or another program. People sign in, not
  software.

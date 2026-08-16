# Your account

The small things every user needs: changing your password, switching
language, and understanding the messages the system shows you.

## Purpose

Most of this manual is about modules. This page is about **you** — the
handful of actions that belong to your own account rather than to any part
of the business.

## Personas

| Persona | What they do here |
|---|---|
| **Everyone** | Change their own password, switch language |
| **Business owner** | Also sees licence and renewal messages |

## Quick reference

- Your account menu is at the **bottom of the sidebar** — click your name
- **Change password** is there, for every user, not just admins
- Language switches with the **ع / EN** button at the top
- Changing your password signs you out everywhere, on purpose

---

=== "Operator's view"

    ### Change your password

    1. Click **your name** at the bottom of the sidebar.
    2. Choose **Change Password**.
    3. Enter your current password, then the new one twice.
    4. Save.

    You will be asked to **sign in again** with the new password. That is
    deliberate: if you are changing your password because you think someone
    else knows it, signing everything out is the point. Anyone using your
    account elsewhere is kicked out too.

    You need your current password to do this. Nobody else — not even an
    administrator — has to be involved.

    !!! tip "Forgot your password?"
        You cannot reset it yourself. Ask an administrator; they can set a
        new one for you, and you will be asked to change it when you next
        sign in.

    ### Switch language

    Use the **ع / EN** button in the top bar. The whole interface switches,
    including the direction of the layout for Arabic. Your choice is
    remembered on that device.

    Names your business typed in itself — your own product names, your own
    categories — stay exactly as you typed them. Only the system's own
    wording changes.

    ### Messages you might see

    | Message | What it means | What to do |
    |---|---|---|
    | **All licensed seats are in use** | Your business pays for a set number of people signed in at once, and they all are | Ask a colleague to sign out, or ask your provider for more seats |
    | **Your licence expires in N days** | A renewal is due | Tell whoever handles your account |
    | **Your licence has expired — access stops in N days** | The renewal is late; you still have those days | Renew now; your data is safe either way |
    | **Session expired due to inactivity** | You were idle for 30 minutes | Sign in again |
    | **Account is disabled** | An administrator switched your account off | Ask your administrator |

    !!! note "Signing in on your phone as well"
        Signing in somewhere new signs you out of the previous place. That
        is one account, one session — it is not an error, and it does not
        use a second seat.

=== "Administrator's view"

    ### Resetting someone's password

    **Users → the person → Reset password.** Set a new one and give it to
    them; they are asked to change it at their next sign-in, so the
    password you chose does not stay in use.

    Resetting also signs that user out everywhere.

    ### Seats

    If staff report "all licensed seats are in use", the business has more
    people trying to work at once than it is licensed for. Seats free
    themselves when someone signs out, or after 30 minutes of inactivity.

    **Administrators are never blocked by the seat limit**, so you can
    always get in to deactivate an account or contact your provider.

    ### Deactivating someone who has left

    **Users → the person → toggle off.** Their account stops working
    immediately and stops holding a seat. Their history stays in the audit
    trail — accounts are switched off, never deleted, so past documents
    still show who created them.

=== "Auditor's view"

    Password changes, resets, sign-ins and sign-outs are all recorded in the
    audit trail with the account and time.

    Session records hold the IP address and browser for each sign-in, and
    are revoked — not deleted — so the history of who was signed in when
    survives.

    A password change revokes every session for that account, so a token
    captured before the change stops working. An administrator's reset does
    the same.

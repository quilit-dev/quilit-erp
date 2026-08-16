# Sending invoices & quotations

How a document gets from the ERP to your customer — by email or WhatsApp —
and what the customer sees when it arrives.

## Purpose

You do not attach a file. You send a **link**.

The link opens a web page showing the document, so the customer sees it on a
phone without downloading anything, and you can see whether they opened it. If
you ever need to stop someone seeing a document again, you revoke the link and
it stops working — which you cannot do with a PDF once it has left your outbox.

## Personas

| Persona | What they do here |
|---|---|
| **Sales rep** | Sends a quotation the moment it is agreed |
| **Accountant** | Sends the invoice, chases the ones never opened |
| **Manager** | Reviews what went out, to whom, and when |

## Quick reference

- **Where**: the **Send** button on any invoice or quotation row
- **Channels**: WhatsApp and email
- **WhatsApp** works with no setup at all
- **Email** needs your provider to configure it once
- Links expire after 30 days by default, and can be revoked at any time
- The history lives at **Sales → Communications**

---

=== "Operator's view"

    ### Send a document

    1. Open **Invoices** (or **Quotations**).
    2. Find the row and click **Send**.
    3. Pick **WhatsApp** or **Email**.
    4. Check the message, then send.

    That is the whole job. The document is not attached — the message
    contains a link to it.

    ### WhatsApp

    Clicking Send opens **your own WhatsApp** with the message already
    written, to the customer's number from their client record.

    **You still have to press send in WhatsApp.** The ERP does not send it
    for you and cannot see whether you did, which is why the history says
    *opened*, not *sent*, for WhatsApp.

    If the customer has no phone number saved, add one to their client
    record first.

    ### Email

    Clicking Send sends the email from your company's address — nothing
    else to do.

    If email has not been set up, the Email tab explains that instead of
    failing when you press send. Ask whoever provides your ERP to configure
    it; it is a one-time job.

    ### What your customer sees

    A clean page with your logo, your company details, the line items, the
    totals, the payment history and your bank details — **the same document
    you print**. They can print it or save it as a PDF from that page.

    They do not need an account, a password, or the app.

    ### Checking whether it was opened

    Go to **Sales → Communications**. Every send is listed with the
    document, the channel, who it went to, and whether it has been opened.

    The **never opened** counter is the one worth acting on: those are
    customers who have not seen what you sent them.

    ### Stopping a link

    In the same list, **Revoke** any link. It stops working immediately —
    useful if you sent the wrong document or to the wrong person.

    !!! tip "Sent the wrong thing?"
        Revoke the link first, then send the corrected document. The old
        link will show "no longer available" rather than the old figures.

=== "Administrator's view"

    ### Turning it on

    **Client Communications** is a licensed module. If the Send button is
    missing, the module is not enabled for your business — the person who
    provides your ERP switches it on.

    ### Email setup

    Email needs two things from your provider: a key for the sending service
    and a **from** address on a domain they have verified. Until both exist, the
    email channel reports itself unavailable in the UI and explains why,
    rather than failing silently at the moment somebody presses send.

    WhatsApp needs nothing. The server builds a `wa.me` link and the
    message leaves the sender's own WhatsApp account.

    ### Link lifetime

    Links expire after 30 days by default. Your provider can change this,
    including making them never expire.

=== "Auditor's view"

    Every send is recorded: which document, which channel, which recipient,
    when it was sent, and when it was first opened.

    Each link is a single-purpose credential:

    - it opens **one** document, read-only
    - it cannot be used to reach any other record or any other customer
    - it expires, and can be revoked
    - it is not stored anywhere in a form that could be replayed, so a copy
      of the database yields no working links
    - every rejected link returns the same "not available" response,
      whether it expired, was revoked, or never existed

    The customer-facing page deliberately omits the client's own phone and
    email. A link can be forwarded, and contact details are not needed to
    read an invoice.

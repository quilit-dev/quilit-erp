// Change an existing business's licence — the upgrade/downgrade path.
//
// Provisioning and editing look similar but carry different risk. At
// provisioning nothing exists yet, so a wrong tick is free. Here the customer
// is already working in the system, so REMOVING a module hides screens and
// blocks endpoints for people mid-task. That is why this screen leads with the
// diff rather than the checkboxes: the operator's real question is not "what is
// ticked" but "what am I about to change", and a downgrade needs to be
// deliberate.
//
// Data is never deleted by a downgrade — the tables stay, the module is just
// unlicensed. Re-enabling restores access to the same records, which is what
// makes a downgrade safe to reverse and worth saying out loud on screen.
import { useMemo, useState } from 'react';
import { toast } from '../../components/shared';
import { pfetch } from './api';
import { ModulePicker, useModuleGraph, label } from './ModulePicker';

export default function ModuleEditor({ tenant, onClose, onSaved }) {
  // `modules` on the catalog row is the SELECTED set (comma-separated), not
  // the resolved one — the same shape the wizard submits.
  const initial = useMemo(
    () => (tenant.modules || '').split(',').map(s => s.trim()).filter(Boolean),
    [tenant.modules]);

  const { graph, selected, effective, lockedBy, toggle, error, ready } =
    useModuleGraph(pfetch, initial);
  const [busy, setBusy] = useState(false);

  const initialSet = useMemo(() => new Set(initial), [initial]);
  const wasUnrestricted = initial.length === 0;

  // Diff against the EFFECTIVE set, because that is what the customer
  // experiences — a module pulled in by a dependency is just as visible to
  // them as one that was ticked directly.
  const initialEffective = useMemo(() => {
    if (wasUnrestricted) return null;         // "everything" has no meaningful diff
    const out = new Set([...initialSet, ...graph.alwaysOn]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const k of [...out]) {
        for (const d of (graph.requires[k] || [])) {
          if (!out.has(d)) { out.add(d); grew = true; }
        }
      }
    }
    return out;
  }, [initialSet, graph, wasUnrestricted]);

  const added = useMemo(() => initialEffective
    ? [...effective].filter(k => !initialEffective.has(k)).sort() : [],
    [effective, initialEffective]);
  const removed = useMemo(() => initialEffective
    ? [...initialEffective].filter(k => !effective.has(k)).sort() : [],
    [effective, initialEffective]);

  const changed = wasUnrestricted || added.length > 0 || removed.length > 0;

  async function save() {
    setBusy(true);
    try {
      // Send the SELECTED keys; the backend applies the same closure, so the
      // two can never disagree about what was actually licensed.
      await pfetch('PUT', `/api/platform/tenants/${tenant.slug}`,
        { modules: [...selected] });
      toast('Licence updated');
      onSaved?.();
      onClose();
    } catch (e) {
      toast(e.message, 'red');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <span className="modal-title">
            Modules — {tenant.name || tenant.slug}
          </span>
        </div>

        <div className="modal-body" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
          {error && (
            <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</div>
          )}

          {wasUnrestricted && (
            <div style={{
              background: 'var(--yellow-light)', color: 'var(--yellow)',
              border: '1px solid var(--yellow)', borderRadius: 'var(--r-sm)',
              padding: '10px 12px', fontSize: 12.5, marginBottom: 14,
            }}>
              <strong>This business has no licence recorded, so it currently sees
              every module.</strong> Pick what they actually bought and save — that
              replaces the open access with a real licence.
            </div>
          )}

          {!ready && !error && (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading modules…</div>
          )}

          {ready && (
            <>
              <ModulePicker graph={graph} selected={selected} effective={effective}
                lockedBy={lockedBy} toggle={toggle} />

              <div style={{
                borderTop: '1px solid var(--rule)', paddingTop: 12, marginTop: 4,
                fontSize: 12.5,
              }}>
                <div style={{ color: 'var(--text-2)', marginBottom: 6 }}>
                  <strong>{selected.size}</strong> selected ·{' '}
                  <strong>{effective.size}</strong> licensed after dependencies
                </div>

                {added.length > 0 && (
                  <div style={{ color: 'var(--green)', marginBottom: 4 }}>
                    <strong>Enabling:</strong> {added.map(label).join(', ')}
                  </div>
                )}
                {removed.length > 0 && (
                  <div style={{ color: 'var(--red)' }}>
                    <strong>Disabling:</strong> {removed.map(label).join(', ')}
                    <div style={{ color: 'var(--text-2)', marginTop: 4 }}>
                      Their users lose these screens immediately. Existing records are
                      kept, not deleted — re-enabling restores access to the same data.
                    </div>
                  </div>
                )}
                {!wasUnrestricted && !added.length && !removed.length && (
                  <div style={{ color: 'var(--text-3)' }}>No changes.</div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready || !changed}>
            {busy ? 'Saving…' : 'Save licence'}
          </button>
        </div>
      </div>
    </div>
  );
}

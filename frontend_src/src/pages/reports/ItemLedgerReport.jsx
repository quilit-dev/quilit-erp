// Item ledger: one item's whole story over the period --- every sale and who
// bought it, purchases, returns, and every stock movement with its balance.
//
// Opened from Reports (pick the item) or from an inventory row's Ledger
// button, which arrives with the item already chosen. Cost, purchase prices,
// profit and stock value appear only when the server says the user may see
// cost (`show_cost`); otherwise those fields are simply not in the response.
import { useState, useEffect, useRef } from 'react';
import { LoadingSpinner, ErrorAlert, EmptyState, fmt, fmtDate } from '../../components/shared';
import { getInventory, getReportItemLedger } from '../../api/client';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useLocale } from '../../hooks/useLocale.jsx';
import SearchSelect from '../../components/SearchSelect.jsx';
import { StatCard, VBarChart, ExportButtons } from './charts';

const qty = v => String(+Number(v || 0).toFixed(3));

function Section({ title, count, rows, columns, baseName, pdfTitle, subtitle, t, children }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between',
                                            alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3>{title} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({count})</span></h3>
        {rows && rows.length > 0 && (
          <ExportButtons rows={rows} columns={columns} baseName={baseName}
            pdfTitle={pdfTitle} subtitle={subtitle} t={t} />
        )}
      </div>
      {children}
    </div>
  );
}

function Table({ columns, rows, empty }) {
  if (!rows.length) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{empty}</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map(c => <th key={c.label} style={{ textAlign: c.align === 'right' ? 'right' : undefined }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c.label} style={{ textAlign: c.align === 'right' ? 'right' : undefined,
                                           whiteSpace: c.nowrap ? 'nowrap' : undefined, ...(c.style ? c.style(r) : {}) }}>
                  {c.render ? c.render(r) : c.value(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemLedgerReport({ params, t, initialItem = null }) {
  const { tStatus, tEnumValue, tCategory } = useLocale();
  const [itemId, setItemId] = usePersistedState('reports_ledger_item', '');
  const [items, setItems] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Arriving from an inventory row: that item, whatever was picked last time.
  useEffect(() => { if (initialItem) setItemId(String(initialItem)); }, [initialItem]);
  useEffect(() => {
    getInventory().then(d => setItems(Array.isArray(d) ? d : (d.items || []))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!itemId) { setData(null); return undefined; }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true); setError(null);
    getReportItemLedger({ ...params, inventory_id: itemId }, ctrl.signal)
      .then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [JSON.stringify(params), itemId]);

  const picker = (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{t('reports.ledgerItem')}</span>
        <SearchSelect className="form-control" style={{ width: 360, maxWidth: '100%' }}
          value={itemId ? Number(itemId) : ''} placeholder={t('reports.ledgerPickItem')}
          onChange={v => setItemId(v ? String(v) : '')}
          options={items.map(i => ({ value: i.id, label: i.name }))} />
      </div>
    </div>
  );

  if (!itemId) return <div>{picker}<EmptyState message={t('reports.ledgerPickItemHint')} /></div>;
  if (loading && !data) return <div>{picker}<LoadingSpinner /></div>;
  if (error) return <div>{picker}<ErrorAlert message={error} /></div>;
  if (!data) return picker;

  const { item, summary: s, show_cost: cost } = data;
  const unit = item.unit ? ` ${item.unit}` : '';
  const range = `${item.name} · ${fmtDate(data.start)} → ${fmtDate(data.end)}`;
  const base = `item_ledger_${String(item.name).replace(/[^\p{L}\p{N}]+/gu, '_')}`;
  const sourceLabel = src => src === 'pos' ? t('reports.ledgerTill')
    : src === 'service' ? t('reports.ledgerService') : t('reports.ledgerInvoice');

  const salesCols = [
    { label: t('common.date'), value: r => r.date, render: r => fmtDate(r.date), nowrap: true },
    { label: t('reports.ledgerDocument'), value: r => r.invoice_number,
      render: r => <>{r.invoice_number}<div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sourceLabel(r.source)}</div></> },
    { label: t('common.client'), value: r => r.client_name || t('reports.walkIn') },
    { label: t('reports.qtySold'), value: r => r.quantity, render: r => `${qty(r.quantity)}${r.unit ? ` ${r.unit}` : ''}`, align: 'right' },
    { label: t('clients.unitPrice'), value: r => r.unit_price, render: r => fmt(r.unit_price), align: 'right' },
    { label: t('clients.discount'), value: r => r.discount, render: r => (r.discount > 0 ? fmt(r.discount) : '—'), align: 'right' },
    { label: t('reports.netSales'), value: r => r.net, render: r => <strong>{fmt(r.net)}</strong>, align: 'right' },
    ...(cost ? [{ label: t('reports.cost'), value: r => r.cost,
                  render: r => `${fmt(r.cost)}${r.cost_estimated ? ' *' : ''}`, align: 'right' }] : []),
    { label: t('common.status'), value: r => tStatus(r.payment_status), render: r => tStatus(r.payment_status) },
  ];
  const customerCols = [
    { label: t('common.client'), value: r => r.client_name || t('reports.walkIn') },
    { label: t('reports.qtySold'), value: r => r.quantity, render: r => `${qty(r.quantity)}${unit}`, align: 'right' },
    { label: t('reports.qtyReturned'), value: r => r.returned, render: r => (r.returned ? qty(r.returned) : '—'), align: 'right' },
    { label: t('reports.netSales'), value: r => r.net_sales, render: r => fmt(r.net_sales), align: 'right' },
    { label: t('reports.invoicesCount'), value: r => r.invoices, align: 'right' },
    { label: t('reports.lastSold'), value: r => r.last_date || '', render: r => (r.last_date ? fmtDate(r.last_date) : '—'), nowrap: true },
  ];
  const purchaseCols = [
    { label: t('common.date'), value: r => r.date, render: r => fmtDate(r.date), nowrap: true },
    { label: t('reports.ledgerPurchase'), value: r => r.po_number },
    { label: t('returns.supplier'), value: r => r.supplier },
    { label: t('common.status'), value: r => tStatus(r.status), render: r => tStatus(r.status) },
    { label: t('reports.ledgerQtyIn'), value: r => r.quantity, render: r => `${qty(r.quantity)}${unit}`, align: 'right' },
    ...(cost ? [
      { label: t('reports.ledgerUnitCost'), value: r => r.unit_cost, render: r => fmt(r.unit_cost), align: 'right' },
      { label: t('reports.ledgerLandedCost'), value: r => r.landed_unit_cost, render: r => fmt(r.landed_unit_cost), align: 'right' },
      { label: t('common.total'), value: r => r.total, render: r => fmt(r.total), align: 'right' },
    ] : []),
  ];
  const returnInCols = [
    { label: t('common.date'), value: r => r.date, render: r => fmtDate(r.date), nowrap: true },
    { label: t('returns.number'), value: r => r.return_number },
    { label: t('returns.invoice'), value: r => r.invoice_number },
    { label: t('common.client'), value: r => r.client_name || t('reports.walkIn') },
    { label: t('reports.qtyReturned'), value: r => r.quantity, render: r => qty(r.quantity), align: 'right' },
    { label: t('returns.condition'), value: r => r.condition,
      render: r => (r.condition === 'restock' ? t('returns.condRestock')
        : r.condition === 'damaged' ? t('returns.condDamaged') : t('returns.condMoneyOnly')) },
    { label: t('reports.netSales'), value: r => r.net, render: r => fmt(r.net), align: 'right' },
  ];
  const returnOutCols = [
    { label: t('common.date'), value: r => r.date, render: r => fmtDate(r.date), nowrap: true },
    { label: t('returns.number'), value: r => r.return_number },
    { label: t('returns.purchase'), value: r => r.po_number },
    { label: t('returns.supplier'), value: r => r.supplier },
    { label: t('reports.qtyReturned'), value: r => r.quantity, render: r => qty(r.quantity), align: 'right' },
    ...(cost ? [{ label: t('returns.total'), value: r => r.net, render: r => fmt(r.net), align: 'right' }] : []),
  ];
  const moveCols = [
    { label: t('common.date'), value: r => (r.created_at || '').slice(0, 16), nowrap: true },
    { label: t('common.type'), value: r => tEnumValue(r.type) },
    { label: t('inventory.delta'), value: r => r.delta, align: 'right',
      render: r => `${r.delta >= 0 ? '+' : ''}${qty(r.delta)}`,
      style: r => ({ fontWeight: 600, color: r.delta >= 0 ? 'var(--green)' : 'var(--red)' }) },
    { label: t('reports.ledgerBalance'), value: r => r.qty_after, render: r => qty(r.qty_after), align: 'right' },
    { label: t('inventory.reference'), value: r => r.reference || '' },
    { label: t('inventory.noteRef'), value: r => tEnumValue(r.note) || '' },
    { label: t('reports.ledgerWarehouse'), value: r => r.warehouse || '' },
  ];

  return (
    <div>
      {picker}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{item.name}</div>
            <div style={{ color: 'var(--text-3)' }}>
              {[item.category && tCategory(item.category), item.barcode].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <div><div className="form-label">{t('reports.onHand')}</div><strong>{qty(item.on_hand)}{unit}</strong></div>
          <div><div className="form-label">{t('reports.ledgerSalePrice')}</div><strong>{fmt(item.sale_price)}</strong></div>
          {cost && <div><div className="form-label">{t('reports.ledgerUnitCost')}</div><strong>{fmt(item.unit_cost)}</strong></div>}
          {cost && <div><div className="form-label">{t('reports.stockValue')}</div><strong>{fmt(item.stock_value)}</strong></div>}
          <div><div className="form-label">{t('reports.lastSold')}</div><strong>{s.last_sale ? fmtDate(s.last_sale) : t('reports.neverSold')}</strong></div>
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <StatCard label={t('reports.unitsSold')} value={`${qty(s.net_quantity)}${unit}`}
          sub={s.quantity_returned > 0 ? t('reports.returnedN', { n: qty(s.quantity_returned) }) : null} />
        <StatCard label={t('reports.netSales')} value={fmt(s.net_sales)} color="green"
          sub={s.average_price != null ? `${t('reports.ledgerAvgPrice')}: ${fmt(s.average_price)}` : null} />
        <StatCard label={t('reports.ledgerCustomers')} value={s.customers}
          sub={`${s.invoices} ${t('reports.invoicesCount')}`} />
        <StatCard label={t('reports.ledgerPurchased')} value={`${qty(s.quantity_purchased)}${unit}`}
          sub={s.quantity_returned_to_suppliers > 0
            ? `${t('reports.ledgerToSuppliers')}: ${qty(s.quantity_returned_to_suppliers)}` : null} />
        {cost && (
          <StatCard label={t('reports.profit')} value={fmt(s.profit)}
            sub={`${t('reports.cost')}: ${fmt(s.cost)}${s.margin_pct != null ? ` · ${s.margin_pct}%` : ''}`} />
        )}
      </div>

      {data.monthly.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><h3>{t('reports.ledgerByMonth')}</h3></div>
          <div className="card-body">
            <VBarChart data={data.monthly} labelKey="month" valueKey="quantity" />
          </div>
        </div>
      )}

      <Section title={t('reports.ledgerSales')} count={data.sales.length} rows={data.sales} columns={salesCols}
        baseName={`${base}_sales`} pdfTitle={`${t('reports.ledgerSales')} — ${item.name}`} subtitle={range} t={t}>
        <Table columns={salesCols} rows={data.sales} empty={t('reports.noSalesInRange')} />
        {cost && s.cost_estimated && (
          <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-3)' }}>* {t('reports.costEstimatedHint')}</div>
        )}
      </Section>

      <Section title={t('reports.ledgerByCustomer')} count={data.customers.length} rows={data.customers}
        columns={customerCols} baseName={`${base}_customers`}
        pdfTitle={`${t('reports.ledgerByCustomer')} — ${item.name}`} subtitle={range} t={t}>
        <Table columns={customerCols} rows={data.customers} empty={t('reports.noSalesInRange')} />
      </Section>

      <Section title={t('reports.ledgerPurchases')} count={data.purchases.length} rows={data.purchases}
        columns={purchaseCols} baseName={`${base}_purchases`}
        pdfTitle={`${t('reports.ledgerPurchases')} — ${item.name}`} subtitle={range} t={t}>
        <Table columns={purchaseCols} rows={data.purchases} empty={t('reports.ledgerNoPurchases')} />
      </Section>

      {(data.returns_in.length > 0 || data.returns_out.length > 0) && (
        <>
          <Section title={t('reports.ledgerCustomerReturns')} count={data.returns_in.length} rows={data.returns_in}
            columns={returnInCols} baseName={`${base}_customer_returns`}
            pdfTitle={`${t('reports.ledgerCustomerReturns')} — ${item.name}`} subtitle={range} t={t}>
            <Table columns={returnInCols} rows={data.returns_in} empty={t('reports.ledgerNoReturns')} />
          </Section>
          <Section title={t('reports.ledgerSupplierReturns')} count={data.returns_out.length} rows={data.returns_out}
            columns={returnOutCols} baseName={`${base}_supplier_returns`}
            pdfTitle={`${t('reports.ledgerSupplierReturns')} — ${item.name}`} subtitle={range} t={t}>
            <Table columns={returnOutCols} rows={data.returns_out} empty={t('reports.ledgerNoReturns')} />
          </Section>
        </>
      )}

      <Section title={t('reports.ledgerMovements')} count={data.movements.length} rows={data.movements}
        columns={moveCols} baseName={`${base}_movements`}
        pdfTitle={`${t('reports.ledgerMovements')} — ${item.name}`} subtitle={range} t={t}>
        <Table columns={moveCols} rows={data.movements} empty={t('inventory.noMovements')} />
      </Section>
    </div>
  );
}

export { ItemLedgerReport };

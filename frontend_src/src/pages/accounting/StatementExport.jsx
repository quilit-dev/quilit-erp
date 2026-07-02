import { ExportButton, toast } from '../../components/shared';
import { exportReportPDF } from '../../utils/exportUtils';

// ── Statement export (Excel + branded PDF), shared by all three statements ────
function StatementExport({ kind, data, t }) {
  if (!data) return null;
  const acct = (r) => `${r.code} ${r.name}`;
  const ind  = (r) => '   ' + acct(r);   // indent line items under a section
  let title, subtitle, filename, sheetName, excelRows, pdfRows, totals, meta;

  if (kind === 'income') {
    title = t('accounting.incomeStatement'); filename = 'Income-Statement'; sheetName = 'Income Statement';
    subtitle = `${data.start} → ${data.end}`;
    meta = { [t('accounting.from')]: data.start, [t('accounting.to')]: data.end };
    excelRows = [
      ...data.income.map(r => ({ Section: t('accounting.income'), Account: acct(r), Amount: r.balance })),
      { Section: t('accounting.income'),  Account: t('accounting.totalIncome'),  Amount: data.total_income },
      ...data.expense.map(r => ({ Section: t('accounting.expense'), Account: acct(r), Amount: r.balance })),
      { Section: t('accounting.expense'), Account: t('accounting.totalExpense'), Amount: data.total_expense },
      { Section: '', Account: t('accounting.netIncome'), Amount: data.net_income },
    ];
    pdfRows = [
      { label: t('accounting.income').toUpperCase(), amount: '' },
      ...data.income.map(r => ({ label: ind(r), amount: r.balance })),
      { label: t('accounting.totalIncome'), amount: data.total_income },
      { label: t('accounting.expense').toUpperCase(), amount: '' },
      ...data.expense.map(r => ({ label: ind(r), amount: r.balance })),
      { label: t('accounting.totalExpense'), amount: data.total_expense },
    ];
    totals = { label: t('accounting.netIncome'), columns: [null, data.net_income] };
  } else if (kind === 'balance') {
    title = t('accounting.balanceSheet'); filename = 'Balance-Sheet'; sheetName = 'Balance Sheet';
    subtitle = `${t('accounting.asOf')} ${data.as_of}`;
    meta = { [t('accounting.asOf')]: data.as_of, [t('accounting.balanced')]: data.balanced ? t('common.yes') : t('common.no') };
    excelRows = [
      ...data.assets.map(r => ({ Section: t('accounting.assets'), Account: acct(r), Amount: r.balance })),
      { Section: t('accounting.assets'), Account: t('accounting.totalAssets'), Amount: data.total_assets },
      ...data.liabilities.map(r => ({ Section: t('accounting.liabilities'), Account: acct(r), Amount: r.balance })),
      ...data.equity.map(r => ({ Section: t('accounting.equity'), Account: acct(r), Amount: r.balance })),
      { Section: t('accounting.equity'), Account: t('accounting.currentEarnings'), Amount: data.net_income },
      { Section: '', Account: t('accounting.liabilitiesAndEquity'), Amount: data.total_liabilities_equity },
    ];
    pdfRows = [
      { label: t('accounting.assets').toUpperCase(), amount: '' },
      ...data.assets.map(r => ({ label: ind(r), amount: r.balance })),
      { label: t('accounting.totalAssets'), amount: data.total_assets },
      { label: t('accounting.liabilities').toUpperCase(), amount: '' },
      ...data.liabilities.map(r => ({ label: ind(r), amount: r.balance })),
      { label: t('accounting.equity').toUpperCase(), amount: '' },
      ...data.equity.map(r => ({ label: ind(r), amount: r.balance })),
      { label: '   ' + t('accounting.currentEarnings'), amount: data.net_income },
    ];
    totals = { label: t('accounting.liabilitiesAndEquity'), columns: [null, data.total_liabilities_equity] };
  } else {
    title = t('accounting.cashFlow'); filename = 'Cash-Flow'; sheetName = 'Cash Flow';
    subtitle = `${data.start} → ${data.end}`;
    meta = { [t('accounting.from')]: data.start, [t('accounting.to')]: data.end };
    const secX = (label, rows) => rows.map(r => ({ Section: label, Account: acct(r), Amount: r.amount }));
    excelRows = [
      ...secX(t('accounting.cfOperating'), data.operating),
      { Section: t('accounting.cfOperating'), Account: t('accounting.cfNetOperating'), Amount: data.total_operating },
      ...secX(t('accounting.cfInvesting'), data.investing),
      { Section: t('accounting.cfInvesting'), Account: t('accounting.cfNetInvesting'), Amount: data.total_investing },
      ...secX(t('accounting.cfFinancing'), data.financing),
      { Section: t('accounting.cfFinancing'), Account: t('accounting.cfNetFinancing'), Amount: data.total_financing },
      { Section: '', Account: t('accounting.cfNetChange'),    Amount: data.net_change },
      { Section: '', Account: t('accounting.cfOpeningCash'),  Amount: data.opening_cash },
      { Section: '', Account: t('accounting.cfClosingCash'),  Amount: data.closing_cash },
    ];
    const secP = (label, rows, tl, tv) => [
      { label: label.toUpperCase(), amount: '' },
      ...rows.map(r => ({ label: ind(r), amount: r.amount })),
      { label: tl, amount: tv },
    ];
    pdfRows = [
      ...secP(t('accounting.cfOperating'), data.operating, t('accounting.cfNetOperating'), data.total_operating),
      ...secP(t('accounting.cfInvesting'), data.investing, t('accounting.cfNetInvesting'), data.total_investing),
      ...secP(t('accounting.cfFinancing'), data.financing, t('accounting.cfNetFinancing'), data.total_financing),
      { label: t('accounting.cfOpeningCash'), amount: data.opening_cash },
      { label: t('accounting.cfClosingCash'), amount: data.closing_cash },
    ];
    totals = { label: t('accounting.cfNetChange'), columns: [null, data.net_change] };
  }

  const doPDF = () => exportReportPDF({
    title, subtitle, filename, meta, rows: pdfRows, totals,
    columns: [
      { label: t('accounting.account'), align: 'left',  value: r => r.label },
      { label: t('common.amount'),      align: 'right', width: '30%', value: r => r.amount },
    ],
  }).catch(e => toast(e.message, 'red'));

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <ExportButton data={excelRows} filename={filename} sheetName={sheetName} />
      <button className="btn btn-secondary btn-sm" onClick={doPDF} title="Export to PDF">📄 PDF</button>
    </div>
  );
}

export { StatementExport };

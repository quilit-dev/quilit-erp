import { useLocale } from '../../hooks/useLocale.jsx';
import { fmtMonth } from './charts';

function generateInsights(summary, monthly, extras = {}, fmtK = v => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.abs(v).toFixed(0)}`, t = (k) => k) {
  const insights = [];
  if (!summary) return insights;

  const { income, expenses, profit, margin, by_category, prev } = summary;

  // ── 1. Profit trend vs prior period ──────────────────────────────────
  if (prev?.profit_change != null) {
    const ch = prev.profit_change;
    if (ch > 0) {
      insights.push({
        id: 'profit-up', priority: 1, type: 'positive',
        icon: '📈', category: 'Trend',
        title: t('finance.ins.profitUp.t', { pct: ch }),
        detail: t('finance.ins.profitUp.d', { amt: fmtK(profit - (prev.profit || 0)) }),
        action: null,
      });
    } else {
      insights.push({
        id: 'profit-down', priority: 1, type: 'critical',
        icon: '📉', category: 'Trend',
        title: t('finance.ins.profitDown.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.profitDown.d', { amt: fmtK(Math.abs(profit - (prev.profit || 0))) }),
        action: t('finance.ins.profitDown.a'),
      });
    }
  }

  // ── 2. Revenue trend ─────────────────────────────────────────────────
  if (prev?.income_change != null) {
    const ch = prev.income_change;
    if (ch > 15) {
      insights.push({
        id: 'rev-surge', priority: 2, type: 'positive',
        icon: '🚀', category: 'Revenue',
        title: t('finance.ins.revSurge.t', { pct: ch }),
        detail: t('finance.ins.revSurge.d', { amt: fmtK(income - (prev.income || 0)) }),
        action: t('finance.ins.revSurge.a'),
      });
    } else if (ch < -10) {
      insights.push({
        id: 'rev-drop', priority: 1, type: 'critical',
        icon: '⚠️', category: 'Revenue',
        title: t('finance.ins.revDrop.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.revDrop.d', { amt: fmtK(Math.abs(income - (prev.income || 0))) }),
        action: t('finance.ins.revDrop.a'),
      });
    }
  }

  // ── 3. Expense trend ─────────────────────────────────────────────────
  if (prev?.expenses_change != null) {
    const ch = prev.expenses_change;
    if (ch > 20 && income > 0) {
      insights.push({
        id: 'exp-spike', priority: 2, type: 'warning',
        icon: '🧾', category: 'Expenses',
        title: t('finance.ins.expSpike.t', { pct: ch }),
        detail: t('finance.ins.expSpike.d', { amt: fmtK(expenses - (prev.expenses || 0)) }),
        action: t('finance.ins.expSpike.a', { cat: by_category?.[0]?.category }),
      });
    } else if (ch < -10) {
      insights.push({
        id: 'exp-down', priority: 3, type: 'positive',
        icon: '✂️', category: 'Expenses',
        title: t('finance.ins.expDown.t', { pct: Math.abs(ch) }),
        detail: t('finance.ins.expDown.d', { amt: fmtK(Math.abs(expenses - (prev.expenses || 0))) }),
        action: null,
      });
    }
  }

  // ── 4. Profit margin health ───────────────────────────────────────────
  if (income > 0 && margin != null) {
    const m = typeof margin === 'number' ? margin : parseFloat(margin);
    if (m >= 40) {
      insights.push({
        id: 'margin-excellent', priority: 3, type: 'positive',
        icon: '🏆', category: 'Margin',
        title: t('finance.ins.marginExcellent.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginExcellent.d'),
        action: null,
      });
    } else if (m >= 20) {
      insights.push({
        id: 'margin-healthy', priority: 4, type: 'neutral',
        icon: '📊', category: 'Margin',
        title: t('finance.ins.marginHealthy.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginHealthy.d'),
        action: null,
      });
    } else if (m > 0) {
      insights.push({
        id: 'margin-thin', priority: 2, type: 'warning',
        icon: '⚡', category: 'Margin',
        title: t('finance.ins.marginThin.t', { pct: m.toFixed(1) }),
        detail: t('finance.ins.marginThin.d'),
        action: t('finance.ins.marginThin.a'),
      });
    } else {
      insights.push({
        id: 'margin-loss', priority: 1, type: 'critical',
        icon: '🔴', category: 'Margin',
        title: t('finance.ins.marginLoss.t'),
        detail: t('finance.ins.marginLoss.d', { amt: fmtK(Math.abs(profit)) }),
        action: t('finance.ins.marginLoss.a'),
      });
    }
  }

  // ── 5. Expense concentration risk ────────────────────────────────────
  if (by_category?.length > 0 && expenses > 0) {
    const top = by_category[0];
    const topPct = Math.round((top.total / expenses) * 100);
    if (topPct >= 50) {
      insights.push({
        id: 'exp-concentration', priority: 2, type: 'warning',
        icon: '🎯', category: 'Expenses',
        title: t('finance.ins.expConcentration.t', { cat: top.category, pct: topPct }),
        detail: t('finance.ins.expConcentration.d', { amt: fmtK(top.total) }),
        action: t('finance.ins.expConcentration.a'),
      });
    }
    // Top 2 categories dominance
    if (by_category.length >= 2) {
      const top2 = by_category[0].total + by_category[1].total;
      const top2Pct = Math.round((top2 / expenses) * 100);
      if (top2Pct >= 70 && topPct < 50) {
        insights.push({
          id: 'exp-top2', priority: 3, type: 'neutral',
          icon: '📦', category: 'Expenses',
          title: t('finance.ins.expTop2.t', { pct: top2Pct }),
          detail: t('finance.ins.expTop2.d', { c1: by_category[0].category, c2: by_category[1].category }),
          action: t('finance.ins.expTop2.a'),
        });
      }
    }
  }

  // ── 6. Monthly trend analysis ─────────────────────────────────────────
  if (monthly?.length >= 3) {
    const recent = monthly.slice(-3);
    const incomeSlope = recent[2].income - recent[0].income;
    const expenseSlope = recent[2].expenses - recent[0].expenses;

    // Scissors pattern: expenses rising faster than income
    if (expenseSlope > 0 && incomeSlope < expenseSlope && expenses > 0) {
      insights.push({
        id: 'scissors', priority: 2, type: 'warning',
        icon: '✂️', category: 'Trend',
        title: t('finance.ins.scissors.t'),
        detail: t('finance.ins.scissors.d'),
        action: t('finance.ins.scissors.a'),
      });
    }

    // Consistent profitability streak
    const streak = (() => {
      let s = 0;
      for (let i = monthly.length - 1; i >= 0; i--) {
        if (monthly[i].profit > 0) s++; else break;
      }
      return s;
    })();
    if (streak >= 3) {
      insights.push({
        id: 'streak', priority: 4, type: 'positive',
        icon: '🔥', category: 'Trend',
        title: t('finance.ins.streak.t', { n: streak }),
        detail: t('finance.ins.streak.d', { n: streak }),
        action: null,
      });
    }

    // Best and worst months
    const best = monthly.reduce((a, b) => b.profit > a.profit ? b : a);
    const worst = monthly.reduce((a, b) => b.profit < a.profit ? b : a);
    if (monthly.length >= 2) {
      insights.push({
        id: 'best-month', priority: 5, type: 'positive',
        icon: '🏅', category: 'Performance',
        title: t('finance.ins.bestMonth.t', { month: fmtMonth(best.month) }),
        detail: t('finance.ins.bestMonth.d', { amt: fmtK(best.profit) }),
        action: null,
      });
    }
    if (worst.profit < 0) {
      insights.push({
        id: 'worst-month', priority: 3, type: 'warning',
        icon: '📅', category: 'Performance',
        title: t('finance.ins.worstMonth.t', { month: fmtMonth(worst.month) }),
        detail: t('finance.ins.worstMonth.d', { amt: fmtK(Math.abs(worst.profit)) }),
        action: null,
      });
    }

    // Income volatility
    const incomes = monthly.map(m => m.income);
    const avgInc = incomes.reduce((a, b) => a + b, 0) / incomes.length;
    const stdInc = Math.sqrt(incomes.reduce((s, v) => s + Math.pow(v - avgInc, 2), 0) / incomes.length);
    const cvInc = avgInc > 0 ? (stdInc / avgInc) * 100 : 0;
    if (cvInc > 40 && monthly.length >= 3) {
      insights.push({
        id: 'volatility', priority: 3, type: 'warning',
        icon: '〰️', category: 'Revenue',
        title: t('finance.ins.volatility.t', { cv: cvInc.toFixed(0) }),
        detail: t('finance.ins.volatility.d', { avg: fmtK(avgInc), std: fmtK(stdInc) }),
        action: t('finance.ins.volatility.a'),
      });
    }

    // Break-even proximity
    if (income > 0 && expenses > 0) {
      const safetyBuffer = ((income - expenses) / income) * 100;
      if (safetyBuffer > 0 && safetyBuffer < 15) {
        insights.push({
          id: 'breakeven-close', priority: 2, type: 'warning',
          icon: '⚖️', category: 'Risk',
          title: t('finance.ins.breakeven.t', { pct: safetyBuffer.toFixed(1) }),
          detail: t('finance.ins.breakeven.d', { pct: safetyBuffer.toFixed(0) }),
          action: t('finance.ins.breakeven.a'),
        });
      }
    }

    // Growth rate (first vs last month)
    if (monthly.length >= 2) {
      const first = monthly[0], last = monthly[monthly.length - 1];
      if (first.income > 0) {
        const growthRate = ((last.income - first.income) / first.income) * 100;
        if (growthRate > 30) {
          insights.push({
            id: 'growth-strong', priority: 3, type: 'positive',
            icon: '📐', category: 'Revenue',
            title: t('finance.ins.growthStrong.t', { pct: growthRate.toFixed(0) }),
            detail: t('finance.ins.growthStrong.d', { from: fmtK(first.income), to: fmtK(last.income) }),
            action: null,
          });
        }
      }
    }
  }

  // ── 7. Efficiency ratio ───────────────────────────────────────────────
  if (income > 0 && expenses > 0) {
    const efficiencyRatio = (expenses / income) * 100;
    if (efficiencyRatio > 85 && efficiencyRatio <= 100) {
      insights.push({
        id: 'efficiency-poor', priority: 2, type: 'warning',
        icon: '⛽', category: 'Efficiency',
        title: t('finance.ins.efficiencyPoor.t', { cents: efficiencyRatio.toFixed(0) }),
        detail: t('finance.ins.efficiencyPoor.d'),
        action: t('finance.ins.efficiencyPoor.a', { cat: by_category?.[0]?.category }),
      });
    } else if (efficiencyRatio <= 60) {
      insights.push({
        id: 'efficiency-great', priority: 5, type: 'positive',
        icon: '⚡', category: 'Efficiency',
        title: t('finance.ins.efficiencyGreat.t', { cents: efficiencyRatio.toFixed(0) }),
        detail: t('finance.ins.efficiencyGreat.d'),
        action: null,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Everything below reads the cross-module scan (GET /api/insights), which
  // aggregates in SQL across every module the viewer may see. A block that is
  // missing means "not visible to you" and produces no observation — never a
  // zero, which would read as a fact about the business.
  // ══════════════════════════════════════════════════════════════════════
  const ctx = extras || {};
  const add = (o) => insights.push(o);

  // ── 8. The books: months left open, a year left unclosed ──────────────
  const ctl = ctx.controls;
  if (ctl?.unlocked_periods >= 1) {
    add({
      id: 'period-not-locked', priority: 2, type: 'warning',
      icon: '🔒', category: 'Controls',
      title: t('finance.ins.periodNotLocked.t', { n: ctl.unlocked_periods }),
      detail: t('finance.ins.periodNotLocked.d', { label: ctl.unlocked_latest }),
      action: t('finance.ins.periodNotLocked.a'),
    });
  }
  if (ctl?.open_prior_year && ctl.past_close_window) {
    add({
      id: 'fy-not-closed', priority: 2, type: 'warning',
      icon: '📚', category: 'Controls',
      title: t('finance.ins.fyNotClosed.t', { year: ctl.open_prior_year }),
      detail: t('finance.ins.fyNotClosed.d', { amt: fmtK(ctl.open_prior_income || 0) }),
      action: t('finance.ins.fyNotClosed.a'),
    });
  }

  // ── 9. Fixed costs already committed ──────────────────────────────────
  const rec = ctx.recurring;
  if (rec?.monthly > 0 && expenses > 0 && monthly?.length) {
    const perMonth = expenses / Math.max(monthly.length, 1);
    const share = (rec.monthly / perMonth) * 100;
    if (share > 60) {
      add({
        id: 'recurring-heavy', priority: 3, type: 'warning',
        icon: '🔁', category: 'Fixed costs',
        title: t('finance.ins.recurringHeavy.t', { pct: Math.min(share, 999).toFixed(0) }),
        detail: t('finance.ins.recurringHeavy.d', { amt: fmtK(rec.monthly), n: rec.active }),
        action: t('finance.ins.recurringHeavy.a'),
      });
    }
  }
  if (rec?.overdue > 0) {
    add({
      id: 'recurring-overdue', priority: 2, type: 'warning',
      icon: '⏰', category: 'Fixed costs',
      title: t('finance.ins.recurringOverdue.t', { n: rec.overdue }),
      detail: t('finance.ins.recurringOverdue.d', { names: rec.overdue_top || '' }),
      action: t('finance.ins.recurringOverdue.a'),
    });
  }

  // ── 10. The till ──────────────────────────────────────────────────────
  const cash = ctx.cash;
  if (cash?.off >= 3 && cash.short > 5) {
    add({
      id: 'cash-variance', priority: 2, type: 'warning',
      icon: '💵', category: 'Cash',
      title: t('finance.ins.cashVariance.t', { off: cash.off, total: cash.checked }),
      detail: t('finance.ins.cashVariance.d', { amt: fmtK(cash.short) }),
      action: t('finance.ins.cashVariance.a'),
    });
  }

  // ── 11. The rate every dual-currency posting books at ─────────────────
  if (ctx.fx?.age_days >= 7) {
    add({
      id: 'fx-stale', priority: 2, type: 'warning',
      icon: '💱', category: 'FX',
      title: t('finance.ins.fxStale.t', { age: ctx.fx.age_days }),
      detail: t('finance.ins.fxStale.d', {
        rate: Number(ctx.fx.rate || 0).toLocaleString(), age: ctx.fx.age_days }),
      action: t('finance.ins.fxStale.a'),
    });
  }

  // ── 12. Money owed, and how long it takes to arrive ───────────────────
  const ar = ctx.receivables;
  if (ar) {
    if (ar.past_due >= 3) {
      add({
        id: 'ar-overdue', priority: 1, type: 'critical',
        icon: '⏳', category: 'Receivables',
        title: t('finance.ins.arOverdue.t', { n: ar.past_due, amt: fmtK(ar.past_due_value) }),
        detail: t('finance.ins.arOverdue.d', { date: ar.oldest_due }),
        action: t('finance.ins.arOverdue.a'),
      });
    } else if (income > 0 && ar.outstanding > income * 0.5) {
      add({
        id: 'ar-bloated', priority: 3, type: 'warning',
        icon: '💼', category: 'Receivables',
        title: t('finance.ins.arBloated.t', { pct: Math.round(ar.outstanding / income * 100) }),
        detail: t('finance.ins.arBloated.d', { amt: fmtK(ar.outstanding), income: fmtK(income) }),
        action: t('finance.ins.arBloated.a'),
      });
    }
    // Days sales outstanding: at the current billing rate, how many days of
    // sales the open book represents. The one A/R figure comparable month to
    // month, and the one that says whether collection is drifting.
    if (ar.dso != null && ar.dso > 60) {
      add({
        id: 'dso-slow', priority: 2, type: 'warning',
        icon: '📆', category: 'Receivables',
        title: t('finance.ins.dsoSlow.t', { days: Math.round(ar.dso) }),
        detail: t('finance.ins.dsoSlow.d', { days: Math.round(ar.dso), amt: fmtK(ar.outstanding) }),
        action: t('finance.ins.dsoSlow.a'),
      });
    }
  }

  // ── 13. Stock: what is not earning ────────────────────────────────────
  const inv = ctx.inventory;
  if (inv) {
    // Cash on a shelf. Measured by VALUE, because twenty cheap items
    // gathering dust is not the same problem as one expensive one.
    if (inv.dead_value > 0 && inv.dead_share >= 25) {
      add({
        id: 'stock-dead', priority: 2, type: 'warning',
        icon: '🧊', category: 'Inventory',
        title: t('finance.ins.stockDead.t', { pct: Math.round(inv.dead_share) }),
        detail: t('finance.ins.stockDead.d', {
          amt: fmtK(inv.dead_value), n: inv.dead_count,
          days: ctx.scanned?.dead_stock_days || 90 }),
        action: t('finance.ins.stockDead.a'),
      });
    }
    // Out of stock AND selling: the only stockout that costs anything.
    if (inv.stockout_selling >= 1) {
      add({
        id: 'stock-out', priority: 1, type: 'critical',
        icon: '📭', category: 'Inventory',
        title: t('finance.ins.stockOut.t', { n: inv.stockout_selling }),
        detail: t('finance.ins.stockOut.d', { name: inv.stockout_top }),
        action: t('finance.ins.stockOut.a'),
      });
    }
    if (inv.below_reorder >= 1) {
      add({
        id: 'stock-reorder', priority: 3, type: 'warning',
        icon: '📉', category: 'Inventory',
        title: t('finance.ins.stockReorder.t', { n: inv.below_reorder }),
        detail: t('finance.ins.stockReorder.d', { name: inv.below_reorder_top }),
        action: t('finance.ins.stockReorder.a'),
      });
    }
    // Priced under what it cost. Every sale of one loses money, and nothing
    // else in the system says so.
    if (inv.under_cost >= 1) {
      add({
        id: 'price-under-cost', priority: 1, type: 'critical',
        icon: '🩸', category: 'Inventory',
        title: t('finance.ins.underCost.t', { n: inv.under_cost }),
        detail: t('finance.ins.underCost.d', { name: inv.under_cost_top }),
        action: t('finance.ins.underCost.a'),
      });
    }
  }

  // ── 14. Who the revenue actually comes from ───────────────────────────
  const sales = ctx.sales;
  if (sales?.revenue > 0) {
    if (sales.top_client_share >= 40) {
      add({
        id: 'client-concentration', priority: 2, type: 'warning',
        icon: '🎪', category: 'Sales',
        title: t('finance.ins.clientConcentration.t', {
          name: sales.top_client, pct: Math.round(sales.top_client_share) }),
        detail: t('finance.ins.clientConcentration.d', { name: sales.top_client }),
        action: t('finance.ins.clientConcentration.a'),
      });
    }
    if (sales.discount_share >= 10) {
      add({
        id: 'discount-leak', priority: 3, type: 'warning',
        icon: '🏷️', category: 'Sales',
        title: t('finance.ins.discountLeak.t', { pct: Math.round(sales.discount_share) }),
        detail: t('finance.ins.discountLeak.d', { amt: fmtK(sales.discount) }),
        action: t('finance.ins.discountLeak.a'),
      });
    }
    if (sales.top_item && sales.top_item_share >= 25) {
      add({
        id: 'top-seller', priority: 5, type: 'neutral',
        icon: '⭐', category: 'Sales',
        title: t('finance.ins.topSeller.t', {
          name: sales.top_item, pct: Math.round(sales.top_item_share) }),
        detail: t('finance.ins.topSeller.d', { name: sales.top_item }),
        action: null,
      });
    }
  }

  // ── 15. Quoting ───────────────────────────────────────────────────────
  const q = ctx.quotations;
  if (q?.quoted >= 5 && q.win_rate != null && q.win_rate < 30) {
    add({
      id: 'quote-winrate', priority: 3, type: 'warning',
      icon: '🎯', category: 'Quotations',
      title: t('finance.ins.quoteWinRate.t', { pct: Math.round(q.win_rate) }),
      detail: t('finance.ins.quoteWinRate.d', { won: q.accepted, n: q.quoted }),
      action: t('finance.ins.quoteWinRate.a'),
    });
  }
  if (q?.pending >= 3 && q.pending_value > 0) {
    add({
      id: 'quote-pending', priority: 4, type: 'neutral',
      icon: '📬', category: 'Quotations',
      title: t('finance.ins.quotePending.t', { n: q.pending, amt: fmtK(q.pending_value) }),
      detail: t('finance.ins.quotePending.d'),
      action: t('finance.ins.quotePending.a'),
    });
  }

  // ── 16. Buying ────────────────────────────────────────────────────────
  const pur = ctx.purchases;
  if (pur?.stuck_orders >= 1) {
    // Either the goods never came or the receipt was never recorded. The
    // books are wrong either way, and nothing else chases it.
    add({
      id: 'po-stuck', priority: 2, type: 'warning',
      icon: '🚚', category: 'Purchasing',
      title: t('finance.ins.poStuck.t', { n: pur.stuck_orders, days: pur.stuck_days }),
      detail: t('finance.ins.poStuck.d', { amt: fmtK(pur.stuck_value) }),
      action: t('finance.ins.poStuck.a'),
    });
  }
  if (pur?.top_supplier_share >= 50 && pur.spend > 0) {
    add({
      id: 'supplier-concentration', priority: 4, type: 'neutral',
      icon: '🏭', category: 'Purchasing',
      title: t('finance.ins.supplierConcentration.t', {
        name: pur.top_supplier, pct: Math.round(pur.top_supplier_share) }),
      detail: t('finance.ins.supplierConcentration.d', { name: pur.top_supplier }),
      action: t('finance.ins.supplierConcentration.a'),
    });
  }

  // ── 17. Work done and not billed ──────────────────────────────────────
  const svc = ctx.service;
  if (svc?.uninvoiced >= 1) {
    // The most directly convertible figure in the whole panel: revenue
    // already earned, waiting on paperwork.
    add({
      id: 'service-uninvoiced', priority: 1, type: 'critical',
      icon: '🧰', category: 'Service',
      title: t('finance.ins.serviceUninvoiced.t', {
        n: svc.uninvoiced, amt: fmtK(svc.uninvoiced_value) }),
      detail: t('finance.ins.serviceUninvoiced.d'),
      action: t('finance.ins.serviceUninvoiced.a'),
    });
  }
  if (svc?.past_due >= 1) {
    add({
      id: 'service-past-due', priority: 3, type: 'warning',
      icon: '🔧', category: 'Service',
      title: t('finance.ins.servicePastDue.t', { n: svc.past_due }),
      detail: t('finance.ins.servicePastDue.d'),
      action: t('finance.ins.servicePastDue.a'),
    });
  }

  // ── 18. Projects ──────────────────────────────────────────────────────
  const prj = ctx.projects;
  if (prj?.over_budget >= 1) {
    add({
      id: 'project-over-budget', priority: 2, type: 'warning',
      icon: '🏗️', category: 'Projects',
      title: t('finance.ins.projectOverBudget.t', { n: prj.over_budget }),
      detail: t('finance.ins.projectOverBudget.d', {
        name: prj.over_budget_top, amt: fmtK(prj.over_budget_by) }),
      action: t('finance.ins.projectOverBudget.a'),
    });
  }
  if (prj?.unbilled >= 1) {
    add({
      id: 'project-unbilled', priority: 2, type: 'warning',
      icon: '📁', category: 'Projects',
      title: t('finance.ins.projectUnbilled.t', {
        n: prj.unbilled, amt: fmtK(prj.unbilled_value) }),
      detail: t('finance.ins.projectUnbilled.d'),
      action: t('finance.ins.projectUnbilled.a'),
    });
  }

  // ── 19. Pipeline ──────────────────────────────────────────────────────
  const crm = ctx.crm;
  if (crm?.stale >= 3) {
    add({
      id: 'pipeline-stale', priority: 3, type: 'warning',
      icon: '🕸️', category: 'Pipeline',
      title: t('finance.ins.pipelineStale.t', { n: crm.stale, days: crm.stale_days }),
      detail: t('finance.ins.pipelineStale.d'),
      action: t('finance.ins.pipelineStale.a'),
    });
  }
  if (crm?.open_value > 0 && income > 0 && crm.open_value < income * 0.5) {
    add({
      id: 'pipeline-thin', priority: 3, type: 'warning',
      icon: '🔭', category: 'Pipeline',
      title: t('finance.ins.pipelineThin.t', {
        pct: Math.round(crm.open_value / income * 100) }),
      detail: t('finance.ins.pipelineThin.d', {
        amt: fmtK(crm.open_value), income: fmtK(income) }),
      action: t('finance.ins.pipelineThin.a'),
    });
  }

  // ── 20. People ────────────────────────────────────────────────────────
  const hr = ctx.hr;
  if (hr?.payroll > 0 && income > 0) {
    const share = (hr.payroll / income) * 100;
    if (share >= 40) {
      add({
        id: 'payroll-heavy', priority: 3, type: 'warning',
        icon: '👥', category: 'People',
        title: t('finance.ins.payrollHeavy.t', { pct: Math.round(share) }),
        detail: t('finance.ins.payrollHeavy.d', {
          amt: fmtK(hr.payroll), n: hr.headcount }),
        action: t('finance.ins.payrollHeavy.a'),
      });
    }
  }

  // ── 21. Production ────────────────────────────────────────────────────
  const mfg = ctx.manufacturing;
  if (mfg?.stalled >= 1) {
    add({
      id: 'wip-stalled', priority: 3, type: 'warning',
      icon: '⚙️', category: 'Production',
      title: t('finance.ins.wipStalled.t', { n: mfg.stalled, days: mfg.stalled_days }),
      detail: t('finance.ins.wipStalled.d', { amt: fmtK(mfg.stalled_value) }),
      action: t('finance.ins.wipStalled.a'),
    });
  }
  if (inv?.reserved_share >= 30) {
    add({
      id: 'stock-reserved', priority: 4, type: 'neutral',
      icon: '🔐', category: 'Production',
      title: t('finance.ins.stockReserved.t', { pct: Math.round(inv.reserved_share) }),
      detail: t('finance.ins.stockReserved.d'),
      action: t('finance.ins.stockReserved.a'),
    });
  }

  // Rank, then SPREAD. Sorting by priority alone let one noisy area fill the
  // panel — a warehouse with four stock problems pushed an unbilled repair and
  // an unlocked month off the bottom, and the reader saw a stock report rather
  // than a picture of the business. At most two per category, then the best of
  // the rest, so every area that has something to say gets a hearing.
  insights.sort((a, b) => a.priority - b.priority);

  const perCategory = {};
  const spread = [], overflow = [];
  for (const ins of insights) {
    const n = (perCategory[ins.category] || 0) + 1;
    perCategory[ins.category] = n;
    (n <= 2 ? spread : overflow).push(ins);
  }
  return [...spread, ...overflow].slice(0, 10);
}

// ── Smart Insights UI Component ───────────────────────────────────────────
// ── Smart Insights — statistical-report visual treatment ──────────────────
// Theme-aware severity tokens. We deliberately use the design system's
// status colours (var(--red)/--yellow/--green) so dark mode just works.
const INSIGHT_STYLES = {
  critical: { tone: 'var(--red)',    soft: 'var(--red-light)',    glow: 'var(--red-glow)'    },
  warning:  { tone: 'var(--yellow)', soft: 'var(--yellow-light)', glow: 'var(--yellow-glow)' },
  positive: { tone: 'var(--green)',  soft: 'var(--green-light)',  glow: 'var(--green-glow)'  },
  neutral:  { tone: 'var(--text-3)', soft: 'var(--surface-3)',    glow: 'transparent'         },
};

// One row in the insight list. Reads as a single statistical observation:
//   • severity dot anchors the eye
//   • category chip + title carry the headline
//   • detail is the explanatory body
//   • recommendation is a labelled inline aside, not a "click to reveal"
function InsightCard({ insight, index }) {
  const { t } = useLocale();
  const s = INSIGHT_STYLES[insight.type] || INSIGHT_STYLES.neutral;

  return (
    <div
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
        animation: 'fadeSlideUp .35s ease both',
        animationDelay: `${index * 0.04}s`,
        transition: 'border-color var(--motion-fast) var(--ease), box-shadow var(--motion-med) var(--ease), transform var(--motion-med) var(--ease)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = s.tone;
        e.currentTarget.style.boxShadow = `0 0 0 1px ${s.glow}, 0 6px 18px rgba(15,23,42,.06)`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.boxShadow   = 'none';
        e.currentTarget.style.transform   = 'none';
      }}
    >
      {/* Severity column — a refined indicator pair: thin vertical rail +
          a small dot at the top. Reads as a "status meter" rather than an
          emoji avatar — the deliberately editorial look. */}
      <div style={{ position: 'relative', width: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: s.tone,
          boxShadow: `0 0 0 3px ${s.soft}`,
        }} />
        <div style={{
          flex: 1, width: 2, marginTop: 6,
          background: `linear-gradient(180deg,${s.soft} 0%,transparent 100%)`,
          borderRadius: 999,
        }} />
      </div>

      {/* Content */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.6px',
            textTransform: 'uppercase', color: s.tone,
          }}>{t('finance.insCat.' + String(insight.category).toLowerCase().replace(/\s+/g, ''))}</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>·</span>
          <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 500 }}>
            {t(`finance.severity_${insight.type}`) || insight.type}
          </span>
        </div>

        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35, marginBottom: 4, letterSpacing: '-0.1px' }}>
          {insight.title}
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, lineHeight: 1.55 }}>
          {insight.detail}
        </p>

        {insight.action && (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            marginTop: 10, paddingTop: 10,
            borderTop: '1px dashed var(--border)',
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '.5px',
              color: s.tone, textTransform: 'uppercase', minWidth: 90, paddingTop: 1,
            }}>
              {t('finance.recommendation') || 'Recommendation'}
            </div>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
              {insight.action}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SmartInsightsPanel({ insights, scanned }) {
  const { t } = useLocale();
  if (!insights || insights.length === 0) return null;

  // Sort by severity — critical first, then warning, then positive — so the
  // most actionable items always sit at the top of the column.
  const order = { critical: 0, warning: 1, positive: 2, neutral: 3 };
  const sorted = [...insights].sort((a, b) =>
    (order[a.type] ?? 9) - (order[b.type] ?? 9)
  );

  const tally = {
    critical: insights.filter(i => i.type === 'critical').length,
    warning:  insights.filter(i => i.type === 'warning').length,
    positive: insights.filter(i => i.type === 'positive').length,
  };

  // Tiny summary "stat tiles" at the top of the panel — gives the section
  // an at-a-glance statistical feel before the reader scans the detail.
  const summaryTiles = [
    { label: t('finance.tileCritical') || 'Needs attention', n: tally.critical, ...INSIGHT_STYLES.critical },
    { label: t('finance.tileWarning')  || 'Worth watching',  n: tally.warning,  ...INSIGHT_STYLES.warning  },
    { label: t('finance.tilePositive') || 'Trending well',   n: tally.positive, ...INSIGHT_STYLES.positive },
  ];

  return (
    <div className="card fin-card" style={{
      animationDelay: '0.6s', marginBottom: 24, overflow: 'hidden', padding: 0,
    }}>
      {/* Header — minimal, no emoji avatar. A small pulsing dot signals "live
          analytics" the way modern data dashboards do. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, padding: '16px 20px 14px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            position: 'relative', width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent)', flexShrink: 0,
            boxShadow: '0 0 0 4px var(--accent-light)',
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 13.5, fontWeight: 700, color: 'var(--text)',
              letterSpacing: '-0.1px',
            }}>
              {t('finance.smartInsights')}
            </div>
            {/* What the scan actually read. A panel that says it has analysed
                the business should be able to say how much of it — and the
                figure is the real one, counted server-side across the modules
                this user may see, so it can be said without exaggerating. */}
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
              {scanned?.records
                ? t('finance.insightsScanned', {
                    records: Number(scanned.records).toLocaleString(),
                    modules: scanned.modules,
                  })
                : t('finance.insightsSubtitle')}
            </div>
          </div>
        </div>
        <div style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
          textTransform: 'uppercase', letterSpacing: '.6px',
          whiteSpace: 'nowrap',
        }}>
          {sorted.length} {t('finance.observations') || 'observations'}
        </div>
      </div>

      {/* Summary tiles — three at-a-glance counts. Each tile is uniform
          width and uses tokens so it adapts to dark mode. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12, padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}>
        {summaryTiles.map(t_ => (
          <div key={t_.label} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
              background: t_.tone, opacity: t_.n ? 1 : 0.25,
            }} />
            <div style={{
              fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '.5px',
              paddingLeft: 6,
            }}>{t_.label}</div>
            <div style={{
              fontSize: 18, fontWeight: 700,
              color: t_.n ? t_.tone : 'var(--text-3)',
              letterSpacing: '-0.5px',
              fontFeatureSettings: '"tnum"',
            }}>
              {t_.n}
            </div>
          </div>
        ))}
      </div>

      {/* Insight list — vertical column, single-track. Reads top-to-bottom
          like a published report rather than a wall of equally-weighted
          tiles. Two-column layout kicks in above 720px so wide screens
          surface more at once without losing scannability. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: 10,
        padding: 16,
      }}>
        {sorted.map((ins, i) => (
          <InsightCard key={ins.id} insight={ins} index={i} />
        ))}
      </div>
    </div>
  );
}


export { generateInsights, SmartInsightsPanel };

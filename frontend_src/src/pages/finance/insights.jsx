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

  // ── 8. Period locking discipline ──────────────────────────────────────
  // A finished month that hasn't been locked is a backdating risk — anyone
  // with edit perms could still post an invoice or expense into it.
  // Closing each completed month within ~10 days is the industry norm.
  if (Array.isArray(extras.periods)) {
    const today = new Date();
    const thisYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const stale = extras.periods.filter(p => {
      if (p.locked) return false;
      if (p.label === thisYM) return false;         // skip current month
      // Lock target: end-of-month + 10 days
      const endOfMonth = new Date(p.year, p.month, 0);
      const daysSince = Math.floor((today - endOfMonth) / 86400000);
      return daysSince > 10;
    });
    if (stale.length >= 1) {
      const last = stale[0];
      insights.push({
        id: 'period-not-locked', priority: 2, type: 'warning',
        icon: '🔒', category: 'Controls',
        title: t('finance.ins.periodNotLocked.t', { n: stale.length }),
        detail: t('finance.ins.periodNotLocked.d', { label: last.label }),
        action: t('finance.ins.periodNotLocked.a'),
      });
    }
  }

  // ── 9. Recurring-expense run-rate vs current spend ────────────────────
  // The recurring book tells us what costs we have committed to going
  // forward — if it's > 60 % of the current period's expense we surface the
  // dependency, and if any template is overdue we nudge to run it.
  if (Array.isArray(extras.recurring) && extras.recurring.length > 0) {
    const active = extras.recurring.filter(r => r.is_active && !r.archived_at);
    // Monthly equivalent of each frequency, so weekly + quarterly + annual
    // all collapse to a single comparable "per month" figure.
    const stepMonths = { weekly: 1 / 4.33, monthly: 1, quarterly: 3, annual: 12 };
    const monthlyRecurring = active.reduce((s, r) => {
      const step = stepMonths[r.frequency] || 1;
      return s + (Number(r.amount) || 0) / step;
    }, 0);
    if (expenses > 0 && monthlyRecurring > 0) {
      const share = (monthlyRecurring / (expenses / Math.max(monthly?.length || 1, 1))) * 100;
      if (share > 60) {
        insights.push({
          id: 'recurring-heavy', priority: 3, type: 'warning',
          icon: '🔁', category: 'Fixed costs',
          title: t('finance.ins.recurringHeavy.t', { pct: Math.min(share, 999).toFixed(0) }),
          detail: t('finance.ins.recurringHeavy.d', { amt: fmtK(monthlyRecurring), n: active.length }),
          action: t('finance.ins.recurringHeavy.a'),
        });
      }
    }
    const overdue = active.filter(r => r.is_overdue);
    if (overdue.length > 0) {
      insights.push({
        id: 'recurring-overdue', priority: 2, type: 'warning',
        icon: '⏰', category: 'Fixed costs',
        title: t('finance.ins.recurringOverdue.t', { n: overdue.length }),
        detail: t('finance.ins.recurringOverdue.d', { names: overdue.slice(0, 2).map(r => r.name).join('", "') }),
        action: t('finance.ins.recurringOverdue.a'),
      });
    }
  }

  // ── 10. Cash drawer variance ──────────────────────────────────────────
  // A recurring shortage points to till-management problems (skimming,
  // missed receipts, sloppy returns) — surface the pattern, not a single
  // bad close. Three or more variant shifts in the last ten closes is the
  // line we draw.
  if (Array.isArray(extras.cashRecs) && extras.cashRecs.length >= 3) {
    const recent = extras.cashRecs.slice(0, 10);
    const offShifts = recent.filter(r => {
      const v = Number(r.variance_usd || r.variance || 0);
      return Math.abs(v) > 0.01;
    });
    const totalShort = offShifts.reduce(
      (s, r) => s + Math.min(0, Number(r.variance_usd || r.variance || 0)), 0,
    );
    if (offShifts.length >= 3 && totalShort < -5) {
      insights.push({
        id: 'cash-variance', priority: 2, type: 'warning',
        icon: '💵', category: 'Cash',
        title: t('finance.ins.cashVariance.t', { off: offShifts.length, total: recent.length }),
        detail: t('finance.ins.cashVariance.d', { amt: fmtK(Math.abs(totalShort)) }),
        action: t('finance.ins.cashVariance.a'),
      });
    }
  }

  // ── 11. FX rate freshness (LBP exposure) ─────────────────────────────
  // Every LBP cash posting books at the latest spot. A rate stale for a
  // week means the books drift from reality on every dual-currency txn,
  // and the trial balance silently absorbs the gap as fictitious profit.
  if (extras.fxRate?.created_at) {
    const age = Math.floor(
      (Date.now() - new Date(extras.fxRate.created_at).getTime()) / 86400000,
    );
    if (age >= 7) {
      insights.push({
        id: 'fx-stale', priority: 2, type: 'warning',
        icon: '💱', category: 'FX',
        title: t('finance.ins.fxStale.t', { age }),
        detail: t('finance.ins.fxStale.d', { rate: Number(extras.fxRate.rate || 0).toLocaleString(), age }),
        action: t('finance.ins.fxStale.a'),
      });
    }
  }

  // ── 12. Open receivables vs revenue ──────────────────────────────────
  // A ballooning A/R book against modest revenue is a collection problem
  // even before any single invoice goes overdue. We compute both: the
  // ratio against current-period income (collection efficiency) AND the
  // count past due date (collection urgency).
  if (Array.isArray(extras.overdueAr)) {
    const open = extras.overdueAr.filter(i =>
      ['Unpaid', 'Partial'].includes(i.status) && !i.voided_at,
    );
    const today = new Date();
    const past = open.filter(i => i.due_date && new Date(i.due_date) < today);
    const outstanding = open.reduce(
      (s, i) => s + (Number(i.amount) - Number(i.paid || 0)), 0,
    );
    if (past.length >= 3) {
      const overdue$ = past.reduce(
        (s, i) => s + (Number(i.amount) - Number(i.paid || 0)), 0,
      );
      insights.push({
        id: 'ar-overdue', priority: 1, type: 'critical',
        icon: '⏳', category: 'Receivables',
        title: t('finance.ins.arOverdue.t', { n: past.length, amt: fmtK(overdue$) }),
        detail: t('finance.ins.arOverdue.d', { date: past
          .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0]
          .due_date?.slice(0, 10) }),
        action: t('finance.ins.arOverdue.a'),
      });
    } else if (income > 0 && outstanding > income * 0.5) {
      insights.push({
        id: 'ar-bloated', priority: 3, type: 'warning',
        icon: '💼', category: 'Receivables',
        title: t('finance.ins.arBloated.t', { pct: Math.round(outstanding / income * 100) }),
        detail: t('finance.ins.arBloated.d', { amt: fmtK(outstanding), income: fmtK(income) }),
        action: t('finance.ins.arBloated.a'),
      });
    }
  }

  // ── 13. Fiscal year close ─────────────────────────────────────────────
  // An open prior-year fiscal year past the first quarter of the next year
  // is a red flag for an auditor — closing posts the year-end entry to
  // Retained Earnings and locks the prior year completely.
  if (Array.isArray(extras.fiscalYears)) {
    const today = new Date();
    const thisYear = today.getFullYear();
    const stalePriorYear = extras.fiscalYears.find(fy =>
      fy.status === 'open' && fy.year < thisYear
      // The first 90 days of the new year are a normal close window —
      // only nag once we're past Q1.
      && today.getMonth() >= 3,
    );
    if (stalePriorYear) {
      insights.push({
        id: 'fy-not-closed', priority: 2, type: 'warning',
        icon: '📚', category: 'Controls',
        title: t('finance.ins.fyNotClosed.t', { year: stalePriorYear.year }),
        detail: t('finance.ins.fyNotClosed.d', { amt: fmtK(stalePriorYear.net_income || 0) }),
        action: t('finance.ins.fyNotClosed.a'),
      });
    }
  }

  // Sort by priority (lower = show first), then de-duplicate similar types
  insights.sort((a, b) => a.priority - b.priority);

  // Cap at 8 most valuable insights — the panel grew with the new module
  // branches; 6 was sometimes hiding genuinely actionable controls items.
  return insights.slice(0, 8);
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

function SmartInsightsPanel({ insights }) {
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
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
              {t('finance.insightsSubtitle')}
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

/* calculator.js — paycheckbystate.com
 * Tools: paycheck · salaryHourly · incomeTax · overtime · raise · w4 · bonus · timesheet
 *
 * DATA — assets/tax-data.js (window.TAXDATA), parsed from saved sources on 2026-09-16:
 *   · Federal withholding: IRS Publication 15-T (2026), Worksheet 1A + Annual Percentage Method Tables for
 *     Automated Payroll Systems (standard and Step 2 checkbox schedules; $12,900 / $8,600 Worksheet 1A adjustment).
 *   · Social Security: SSA — 2026 wage base $184,500, 6.2%. Medicare: IRS Topic 751 — 1.45%, plus 0.9% withheld on
 *     wages above $200,000 in the year regardless of filing status.
 *   · State income tax: Tax Foundation, State Individual Income Tax Rates and Brackets as of January 1, 2026
 *     (brackets, standard deductions, personal exemptions or exemption credits). Washington is shown as no wage
 *     tax per Tax Foundation's own note (its tax applies to high earners' capital gains).
 *   · 2026 federal brackets and standard deduction (income tax tool): IRS newsroom, tax inflation adjustments
 *     for tax year 2026 — single $16,100 / joint $32,200 / head of household $24,150; bracket thresholds as
 *     published. Head-of-household thresholds are read from the Pub 15-T HoH table (column A minus its 0% band),
 *     which reproduces the IRS single and joint thresholds exactly.
 *   · Supplemental (bonus) withholding: IRS Publication 15 — 22%, or 37% above $1 million.
 * STATE TAX IS AN ESTIMATE: it applies each state's brackets to annual wages minus the state standard deduction
 * and exemption. It leaves out local income taxes, state payroll taxes (e.g. disability insurance), state
 * credits and states' own treatment of retirement contributions. The page says so next to the number.
 */
(function (root, factory) {
  const C = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = C; else root.CALCS = C;
})(typeof self !== 'undefined' ? self : this, function (root) {
  let TAX = root && root.TAXDATA;
  const r2 = n => Math.round(n * 100) / 100;
  const PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, annual: 1 };
  const FED2026 = {   // IRS newsroom, 2026 inflation adjustments; HoH from Pub 15-T HoH table
    std: { single: 16100, mfj: 32200, hoh: 24150 },
    brackets: {
      single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
      mfj: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24], [403550, 0.32], [512450, 0.35], [768700, 0.37]],
      hoh: [[0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24], [201750, 0.32], [256200, 0.35], [640600, 0.37]],
    },
    supplemental: 0.22, supplementalOver1M: 0.37,
  };

  // ── pure tax math ────────────────────────────────────────────────────────
  function federalWithholding({ annualWages, status = 'single', step2 = false, step3 = 0, step4a = 0, step4b = 0, step4c = 0, periods = 26 }) {
    const t = TAX.federal;
    const adjAmt = step2 ? 0 : t.w4_adjustment[status === 'mfj' ? 'mfj' : 'other'];
    const adjusted = Math.max(0, annualWages + step4a - (step4b + adjAmt));
    const rows = t.tables[status][step2 ? 'step2_checkbox' : 'standard'];
    const row = rows.find(r => adjusted >= r.min && (r.max == null || adjusted < r.max));
    const tentative = row.base + (adjusted - row.min) * row.rate;
    return Math.max(0, tentative / periods - step3 / periods) + step4c;
  }
  function fica(annualFicaWages) {
    const f = TAX.fica;
    const ss = Math.min(annualFicaWages, f.ss_wage_base) * f.ss_rate;
    const medicare = annualFicaWages * f.medicare_rate + Math.max(0, annualFicaWages - f.addl_medicare_threshold) * f.addl_medicare_rate;
    return { ss, medicare };
  }
  const amt = x => (x && typeof x.deduction === 'number') ? x.deduction : 0;
  const cred = x => (x && typeof x.credit === 'number') ? x.credit : 0;
  function stateTax(annualIncome, ab, status = 'single') {
    const s = TAX.states.data[ab];
    if (!s || s.no_wage_tax) return { tax: 0, taxable: 0, none: true };
    const joint = status === 'mfj';
    const br = s[joint ? 'mfj' : 'single'].length ? s[joint ? 'mfj' : 'single'] : s.single;
    const taxable = Math.max(0, annualIncome - amt(s[joint ? 'std_mfj' : 'std_single']) - amt(s[joint ? 'exempt_mfj' : 'exempt_single']));
    let tax = 0;
    br.forEach((b, i) => { const top = i + 1 < br.length ? br[i + 1].over : Infinity; if (taxable > b.over) tax += (Math.min(taxable, top) - b.over) * b.rate; });
    return { tax: Math.max(0, tax - cred(s[joint ? 'exempt_mfj' : 'exempt_single'])), taxable, top: br.filter(b => taxable > b.over).pop()?.rate ?? 0 };
  }
  function federalIncomeTax(income, status = 'single', otherDeductions = 0) {
    const taxable = Math.max(0, income - FED2026.std[status] - otherDeductions);
    const br = FED2026.brackets[status];
    let tax = 0, marginal = 0;
    br.forEach(([over, rate], i) => { const top = i + 1 < br.length ? br[i + 1][0] : Infinity; if (taxable > over) { tax += (Math.min(taxable, top) - over) * rate; marginal = rate; } });
    return { taxable, tax, marginal, effective: income ? tax / income : 0 };
  }
  function paycheck({ gross, frequency, status, step2, step3, step4a, step4b, step4c, pretax401kPct, pretaxHealth, state }) {
    const periods = PERIODS[frequency] || 26;
    const k401 = gross * (pretax401kPct || 0) / 100;
    const health = pretaxHealth || 0;
    const fedWages = Math.max(0, gross - k401 - health);           // 401(k) deferrals and section 125 premiums reduce federal income tax wages
    const ficaWages = Math.max(0, gross - health);                 // 401(k) deferrals are still subject to FICA; section 125 premiums are not
    const fedWh = federalWithholding({ annualWages: fedWages * periods, status, step2, step3, step4a, step4b, step4c, periods });
    const f = fica(ficaWages * periods);
    const st = stateTax(fedWages * periods, state, status);
    const ss = f.ss / periods, medicare = f.medicare / periods, stateWh = st.tax / periods;
    const net = gross - k401 - health - fedWh - ss - medicare - stateWh;
    return { periods, k401, health, fedWh, ss, medicare, stateWh, net, stateNone: !!st.none };
  }

  // ── shared inputs ────────────────────────────────────────────────────────
  const stateOptions = () => TAX ? Object.entries(TAX.states.data).map(([ab, s]) => ({ value: ab, label: s.name })).sort((a, b) => a.label.localeCompare(b.label)) : [];
  const statusInput = { id: 'status', label: 'Filing status (Form W-4 Step 1c)', type: 'select', default: 'single', options: [{ value: 'single', label: 'Single or married filing separately' }, { value: 'mfj', label: 'Married filing jointly' }, { value: 'hoh', label: 'Head of household' }] };
  const freqInput = { id: 'frequency', label: 'Pay frequency', type: 'select', default: 'biweekly', options: [['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']].map(([value, label]) => ({ value, label })) };

  const paycheckTool = {
    title: 'Paycheck calculator',
    inputs: [
      { id: 'state', label: 'State you work in', type: 'select', default: 'TX', options: stateOptions },
      { id: 'payType', label: 'You are paid', type: 'radio', default: 'salary', options: [{ value: 'salary', label: 'A salary' }, { value: 'hourly', label: 'By the hour' }] },
      { id: 'salary', label: 'Yearly salary', type: 'number', prefix: '$', default: 65000, min: 0, showIf: s => s.payType !== 'hourly' },
      { id: 'rate', label: 'Hourly rate', type: 'number', prefix: '$', default: 25, min: 0, showIf: s => s.payType === 'hourly' },
      { id: 'hours', label: 'Hours per week', type: 'number', default: 40, min: 0, max: 100, showIf: s => s.payType === 'hourly' },
      freqInput, statusInput,
      { id: 'step2', label: 'Form W-4 Step 2 box is checked (two jobs)', type: 'checkbox', default: false },
      { id: 'step3', label: 'W-4 Step 3: dependent credits (yearly)', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'step4a', label: 'W-4 Step 4(a): other income (yearly)', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'step4b', label: 'W-4 Step 4(b): deductions (yearly)', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'step4c', label: 'W-4 Step 4(c): extra withholding per paycheck', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'pretax401kPct', label: 'Pre-tax 401(k)', type: 'number', suffix: '% of pay', default: 0, min: 0, max: 100, step: 0.5 },
      { id: 'pretaxHealth', label: 'Pre-tax health insurance per paycheck', type: 'number', prefix: '$', default: 0, min: 0 },
    ],
    compute(v, fmt) {
      if (!TAX) return { warnings: ['Tax data did not load.'] };
      const periods = PERIODS[v.frequency] || 26;
      const annual = v.payType === 'hourly' ? (v.rate || 0) * (v.hours || 0) * 52 : (v.salary || 0);
      const gross = annual / periods;
      const p = paycheck({ ...v, gross });
      const s = TAX.states.data[v.state];
      return {
        raw: { gross: r2(gross), fed: r2(p.fedWh), ss: r2(p.ss), medicare: r2(p.medicare), state: r2(p.stateWh), net: r2(p.net) },
        summary: [
          { label: 'Take-home pay per paycheck', value: fmt.money(p.net), strong: true },
          { label: 'Gross pay per paycheck', value: fmt.money(gross) },
          { label: 'Take-home per year', value: fmt.money0(p.net * periods) },
        ],
        rows: [
          { label: 'Gross pay', value: fmt.money(gross) },
          ...(p.k401 ? [{ label: '401(k) (pre-tax)', value: `− ${fmt.money(p.k401)}` }] : []),
          ...(p.health ? [{ label: 'Health insurance (pre-tax)', value: `− ${fmt.money(p.health)}` }] : []),
          { label: 'Federal income tax withholding', value: `− ${fmt.money(p.fedWh)}` },
          { label: 'Social Security (6.2%)', value: `− ${fmt.money(p.ss)}` },
          { label: 'Medicare (1.45%+)', value: `− ${fmt.money(p.medicare)}` },
          { label: `${s ? s.name : 'State'} income tax${p.stateNone ? ' (none on wages)' : ' (estimate)'}`, value: `− ${fmt.money(p.stateWh)}` },
          { label: 'Take-home pay', value: fmt.money(p.net), total: true },
        ],
        notes: [
          'Federal withholding: IRS Publication 15-T (2026) percentage method for a 2020-or-later Form W-4. Social Security capped at the 2026 wage base of $184,500 (SSA). Medicare adds 0.9% on wages above $200,000 (IRS).',
          `State tax: an estimate from Tax Foundation’s 2026 brackets, standard deduction and exemptions for ${s ? s.name : 'your state'}. Local income taxes and state payroll taxes (such as disability insurance) are not included.`,
          'Your employer’s payroll may differ slightly (rounding, year-to-date wage caps, benefits). Not tax advice.',
        ],
      };
    },
  };

  const salaryHourly = {
    title: 'Salary to hourly calculator',
    inputs: [
      { id: 'mode', label: 'Convert', type: 'radio', default: 'toHourly', options: [{ value: 'toHourly', label: 'Salary → hourly' }, { value: 'toSalary', label: 'Hourly → salary' }] },
      { id: 'salary', label: 'Yearly salary', type: 'number', prefix: '$', default: 60000, min: 0, showIf: s => s.mode !== 'toSalary' },
      { id: 'rate', label: 'Hourly rate', type: 'number', prefix: '$', default: 25, min: 0, showIf: s => s.mode === 'toSalary' },
      { id: 'hours', label: 'Hours per week', type: 'number', default: 40, min: 1, max: 100 },
      { id: 'weeks', label: 'Paid weeks per year', type: 'number', default: 52, min: 1, max: 52 },
    ],
    compute(v, fmt) {
      const yearHours = (v.hours || 0) * (v.weeks || 0);
      const annual = v.mode === 'toSalary' ? (v.rate || 0) * yearHours : (v.salary || 0);
      const hourly = yearHours ? annual / yearHours : NaN;
      return {
        raw: { annual: r2(annual), hourly: r2(hourly), monthly: r2(annual / 12), biweekly: r2(annual / 26), weekly: r2(annual / 52) },
        summary: [
          { label: v.mode === 'toSalary' ? 'Yearly salary' : 'Hourly rate', value: v.mode === 'toSalary' ? fmt.money0(annual) : fmt.money(hourly), strong: true },
          { label: 'Monthly', value: fmt.money(annual / 12) },
          { label: 'Every two weeks', value: fmt.money(annual / 26) },
          { label: 'Weekly', value: fmt.money(annual / 52) },
        ],
        notes: [`Based on ${v.hours} hours × ${v.weeks} weeks = ${yearHours.toLocaleString('en-US')} paid hours a year. Before taxes.`],
      };
    },
  };

  const incomeTax = {
    title: 'Income tax calculator',
    inputs: [
      { id: 'income', label: 'Yearly income (wages and other taxable income)', type: 'number', prefix: '$', default: 80000, min: 0 },
      statusInput,
      { id: 'otherDeductions', label: 'Pre-tax contributions and above-the-line deductions', type: 'number', prefix: '$', default: 0, min: 0, help: 'For example traditional 401(k) contributions.' },
      { id: 'state', label: 'State', type: 'select', default: 'CA', options: stateOptions },
    ],
    compute(v, fmt) {
      if (!TAX) return { warnings: ['Tax data did not load.'] };
      const status = v.status || 'single';
      const f = federalIncomeTax(v.income || 0, status, v.otherDeductions || 0);
      const st = stateTax(Math.max(0, (v.income || 0) - (v.otherDeductions || 0)), v.state, status);
      const s = TAX.states.data[v.state];
      return {
        raw: { taxable: r2(f.taxable), federal: r2(f.tax), marginal: f.marginal, effective: r2(f.effective * 100), state: r2(st.tax) },
        summary: [
          { label: '2026 federal income tax', value: fmt.money0(f.tax), strong: true },
          { label: 'Effective federal rate', value: fmt.pct(f.effective * 100) },
          { label: 'Top federal bracket', value: `${Math.round(f.marginal * 100)}%` },
          { label: `${s ? s.name : 'State'} income tax (estimate)`, value: fmt.money0(st.tax) },
        ],
        rows: [{ label: 'Income', value: fmt.money0(v.income || 0) }, { label: `Standard deduction (${status === 'mfj' ? 'joint' : status === 'hoh' ? 'head of household' : 'single'})`, value: `− ${fmt.money0(FED2026.std[status])}` }, { label: 'Other deductions', value: `− ${fmt.money0(v.otherDeductions || 0)}` }, { label: 'Federal taxable income', value: fmt.money0(f.taxable), total: true }],
        notes: ['2026 brackets and standard deduction from the IRS. Credits (child tax credit and others), itemized deductions and special deductions are not included. Not tax advice.'],
      };
    },
  };

  const overtime = {
    title: 'Overtime calculator',
    inputs: [
      { id: 'rate', label: 'Regular hourly rate', type: 'number', prefix: '$', default: 20, min: 0 },
      { id: 'regular', label: 'Regular hours this week', type: 'number', default: 40, min: 0 },
      { id: 'ot', label: 'Overtime hours', type: 'number', default: 10, min: 0 },
      { id: 'mult', label: 'Overtime multiplier', type: 'select', default: '1.5', options: [{ value: '1.5', label: 'Time and a half (1.5×)' }, { value: '2', label: 'Double time (2×)' }] },
    ],
    compute(v, fmt) {
      const reg = (v.rate || 0) * (v.regular || 0), otRate = (v.rate || 0) * Number(v.mult), ot = otRate * (v.ot || 0);
      return {
        raw: { regular: r2(reg), overtimeRate: r2(otRate), overtime: r2(ot), total: r2(reg + ot) },
        summary: [{ label: 'Gross pay this week', value: fmt.money(reg + ot), strong: true }, { label: 'Overtime pay', value: fmt.money(ot) }, { label: 'Overtime hourly rate', value: fmt.money(otRate) }],
        notes: ['Under the federal Fair Labor Standards Act, non-exempt employees earn at least 1.5 times their regular rate for hours over 40 in a workweek; some states add daily overtime or double time. Before taxes.'],
      };
    },
  };

  const raise = {
    title: 'Raise calculator',
    inputs: [
      { id: 'salary', label: 'Current yearly pay', type: 'number', prefix: '$', default: 60000, min: 0 },
      { id: 'mode', label: 'Raise given as', type: 'radio', default: 'pct', options: [{ value: 'pct', label: 'A percentage' }, { value: 'amt', label: 'A dollar amount' }, { value: 'new', label: 'A new salary' }] },
      { id: 'pct', label: 'Raise', type: 'number', suffix: '%', default: 4, min: 0, max: 200, step: 0.1, showIf: s => s.mode === 'pct' },
      { id: 'amount', label: 'Raise amount', type: 'number', prefix: '$', default: 2400, min: 0, showIf: s => s.mode === 'amt' },
      { id: 'newSalary', label: 'New yearly pay', type: 'number', prefix: '$', default: 63000, min: 0, showIf: s => s.mode === 'new' },
      freqInput,
    ],
    compute(v, fmt) {
      const old = v.salary || 0;
      const neu = v.mode === 'amt' ? old + (v.amount || 0) : v.mode === 'new' ? (v.newSalary || 0) : old * (1 + (v.pct || 0) / 100);
      const periods = PERIODS[v.frequency] || 26;
      return {
        raw: { newSalary: r2(neu), increase: r2(neu - old), pct: r2(old ? (neu - old) / old * 100 : NaN), perPaycheck: r2((neu - old) / periods) },
        summary: [{ label: 'New yearly pay', value: fmt.money0(neu), strong: true }, { label: 'Raise', value: `${fmt.money0(neu - old)} (${fmt.pct(old ? (neu - old) / old * 100 : 0)})` }, { label: 'More per paycheck (before tax)', value: fmt.money((neu - old) / periods) }],
      };
    },
  };

  const w4 = {
    title: 'W-4 withholding calculator',
    inputs: [
      { id: 'salary', label: 'Yearly wages from this job', type: 'number', prefix: '$', default: 90000, min: 0 },
      freqInput, statusInput,
      { id: 'otherIncome', label: 'Other taxable income for the year', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'credits', label: 'Tax credits you expect (e.g. child tax credit)', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'paidSoFar', label: 'Federal tax already withheld this year', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'periodsLeft', label: 'Paychecks left this year', type: 'number', default: 26, min: 1, max: 52 },
    ],
    compute(v, fmt) {
      if (!TAX) return { warnings: ['Tax data did not load.'] };
      const periods = PERIODS[v.frequency] || 26;
      const status = v.status || 'single';
      const liability = Math.max(0, federalIncomeTax((v.salary || 0) + (v.otherIncome || 0), status).tax - (v.credits || 0));
      const perCheck = federalWithholding({ annualWages: v.salary || 0, status, periods });
      const projected = (v.paidSoFar || 0) + perCheck * (v.periodsLeft || 0);
      const gap = liability - projected;
      const extra = gap > 0 ? gap / (v.periodsLeft || 1) : 0;
      return {
        raw: { liability: r2(liability), perCheck: r2(perCheck), projected: r2(projected), gap: r2(gap), extra: r2(extra) },
        warnings: gap > 0 ? [`At the default W-4 settings you would owe about ${fmt.money0(gap)} at tax time.`] : [],
        summary: [
          { label: gap > 0 ? 'Add to W-4 Step 4(c) per paycheck' : 'Expected refund (roughly)', value: gap > 0 ? fmt.money(extra) : fmt.money0(-gap), strong: true },
          { label: 'Estimated 2026 federal tax', value: fmt.money0(liability) },
          { label: 'Projected withholding', value: fmt.money0(projected) },
        ],
        notes: ['Estimate for one job and a standard deduction. For two jobs or itemized deductions use the IRS Tax Withholding Estimator (irs.gov/w4app). Not tax advice.'],
      };
    },
  };

  const bonus = {
    title: 'Bonus tax calculator',
    inputs: [
      { id: 'bonus', label: 'Bonus amount', type: 'number', prefix: '$', default: 5000, min: 0 },
      { id: 'ytdSupplemental', label: 'Bonuses already paid this year', type: 'number', prefix: '$', default: 0, min: 0 },
      { id: 'statePct', label: 'Your state’s bonus withholding rate (from your state tax agency)', type: 'number', suffix: '%', default: 0, min: 0, max: 20, step: 0.01 },
      { id: 'ytdWages', label: 'Wages paid this year so far (for the Social Security cap)', type: 'number', prefix: '$', default: 60000, min: 0 },
    ],
    compute(v, fmt) {
      if (!TAX) return { warnings: ['Tax data did not load.'] };
      const b = v.bonus || 0, prior = v.ytdSupplemental || 0;
      const under = Math.max(0, Math.min(b, 1e6 - prior)), over = b - under;
      const fed = under * FED2026.supplemental + over * FED2026.supplementalOver1M;
      const ssRoom = Math.max(0, TAX.fica.ss_wage_base - (v.ytdWages || 0));
      const ss = Math.min(b, ssRoom) * TAX.fica.ss_rate;
      const wagesAfter = (v.ytdWages || 0) + b;
      const med = b * TAX.fica.medicare_rate + Math.max(0, wagesAfter - Math.max(TAX.fica.addl_medicare_threshold, v.ytdWages || 0)) * TAX.fica.addl_medicare_rate;
      const st = b * (v.statePct || 0) / 100;
      const net = b - fed - ss - med - st;
      return {
        raw: { fed: r2(fed), ss: r2(ss), medicare: r2(med), state: r2(st), net: r2(net) },
        summary: [{ label: 'Bonus after withholding', value: fmt.money(net), strong: true }, { label: 'Federal withholding', value: fmt.money(fed) }, { label: 'Social Security + Medicare', value: fmt.money(ss + med) }],
        rows: [{ label: 'Federal (22% flat, 37% above $1M)', value: `− ${fmt.money(fed)}` }, { label: 'Social Security', value: `− ${fmt.money(ss)}` }, { label: 'Medicare', value: `− ${fmt.money(med)}` }, { label: 'State', value: `− ${fmt.money(st)}` }, { label: 'Net bonus', value: fmt.money(net), total: true }],
        notes: ['Uses the IRS flat-rate method for supplemental wages (Publication 15). Withholding is not your final tax: the bonus is taxed with your other income when you file. Not tax advice.'],
      };
    },
  };

  const toMin = t => { const [h, m] = String(t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  function timesheetHours(rows) {
    return rows.reduce((a, r) => { if (!r.in || !r.out) return a; let d = toMin(r.out) - toMin(r.in); if (d < 0) d += 1440; return a + Math.max(0, d - (Number(r.breakMin) || 0)) / 60; }, 0);
  }
  const timesheet = {
    title: 'Timesheet calculator',
    inputs: [
      { id: 'days', label: 'Time entries (24-hour times, e.g. 08:30 and 17:15)', type: 'repeater', addLabel: '+ Add day', columns: [{ id: 'day', label: 'Day' }, { id: 'in', label: 'In' }, { id: 'out', label: 'Out' }, { id: 'breakMin', label: 'Break (min)', type: 'number' }],
        default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(day => ({ day, in: '08:30', out: '17:00', breakMin: 30 })) },
      { id: 'rate', label: 'Hourly rate', type: 'number', prefix: '$', default: 22, min: 0 },
      { id: 'otAfter', label: 'Overtime after (hours per week)', type: 'number', default: 40, min: 0 },
    ],
    compute(v, fmt) {
      const hours = timesheetHours(v.days || []);
      const reg = Math.min(hours, v.otAfter || 40), ot = Math.max(0, hours - (v.otAfter || 40));
      const pay = reg * (v.rate || 0) + ot * (v.rate || 0) * 1.5;
      return {
        raw: { hours: r2(hours), regular: r2(reg), overtime: r2(ot), pay: r2(pay) },
        summary: [{ label: 'Total hours', value: `${r2(hours)} h`, strong: true }, { label: 'Gross pay', value: fmt.money(pay) }, { label: 'Overtime hours', value: `${r2(ot)} h` }],
        notes: ['Times past midnight count into the next day. Overtime paid at 1.5× the regular rate.'],
      };
    },
  };

  return {
    paycheck: paycheckTool, salaryHourly, incomeTax, overtime, raise, w4, bonus, timesheet,
    __setData: d => { TAX = d; },
    __dataGlobal: 'TAXDATA',
    __pure: { federalWithholding, fica, stateTax, federalIncomeTax, paycheck, timesheetHours },
    // Expected values: build/tests/paycheck_expected.py (independent re-implementation over the same parsed sources)
    __tests: [
      { calc: 'paycheck', name: 'Texas, single, $65,000 salary, biweekly → net $2,092.60', input: { state: 'TX', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' },
        expect: { gross: 2500, fed: 216.15, ss: 155, medicare: 36.25, state: 0, net: 2092.6 } },
      { calc: 'paycheck', name: 'California, same pay → state $76.46, net $2,016.14', input: { state: 'CA', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' }, expect: { state: 76.46, net: 2016.14 } },
      { calc: 'paycheck', name: 'married, monthly $8,000, 5% pre-tax 401(k) → fed $548.67, net $6,439.33', input: { state: 'TX', payType: 'salary', salary: 96000, frequency: 'monthly', status: 'mfj', pretax401kPct: 5 },
        expect: { fed: 548.67, ss: 496, medicare: 116, net: 6439.33 } },
      { calc: 'paycheck', name: 'New York / Illinois / Pennsylvania state estimates on $65,000', input: { state: 'NY', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' }, expect: { state: 112.04 } },
      { calc: 'paycheck', name: 'Illinois flat 4.95% after the exemption', input: { state: 'IL', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' }, expect: { state: 118.18 } },
      { calc: 'paycheck', name: 'Pennsylvania flat 3.07%', input: { state: 'PA', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' }, expect: { state: 76.75 } },
      { calc: 'paycheck', name: 'Washington: no state tax on wages', input: { state: 'WA', payType: 'salary', salary: 65000, frequency: 'biweekly', status: 'single' }, expect: { state: 0 } },
      { calc: 'paycheck', name: '$300,000 monthly: Social Security capped, additional Medicare applies', input: { state: 'TX', payType: 'salary', salary: 300000, frequency: 'monthly', status: 'single' },
        expect: { ss: 953.25, medicare: 437.5, fed: 5677.85 } },
      { calc: 'salaryHourly', name: '$25/h × 40 × 52 = $52,000', input: { mode: 'toSalary', rate: 25, hours: 40, weeks: 52 }, expect: { annual: 52000, biweekly: 2000 } },
      { calc: 'salaryHourly', name: '$60,000 / 2,080 h = $28.85/h', input: { mode: 'toHourly', salary: 60000, hours: 40, weeks: 52 }, expect: { hourly: 28.85 } },
      { calc: 'incomeTax', name: '$80,000 single 2026 → $8,770', input: { income: 80000, status: 'single', otherDeductions: 0, state: 'TX' }, expect: { taxable: 63900, federal: 8770, marginal: 0.22 } },
      { calc: 'overtime', name: '$20/h, 40 + 10 h at 1.5× = $1,100', input: { rate: 20, regular: 40, ot: 10, mult: '1.5' }, expect: { overtime: 300, total: 1100 } },
      { calc: 'raise', name: '$60,000 + 4% = $62,400; +$92.31 per biweekly check', input: { salary: 60000, mode: 'pct', pct: 4, frequency: 'biweekly' }, expect: { newSalary: 62400, increase: 2400, perPaycheck: 92.31 } },
      { calc: 'bonus', name: '$5,000 bonus: 22% federal, FICA → $3,517.50', input: { bonus: 5000, ytdSupplemental: 0, statePct: 0, ytdWages: 60000 }, expect: { fed: 1100, ss: 310, medicare: 72.5, net: 3517.5 } },
      { calc: 'bonus', name: 'bonus above the Social Security cap pays no Social Security', input: { bonus: 10000, ytdSupplemental: 0, statePct: 0, ytdWages: 190000 }, expect: { ss: 0, medicare: 145 } },
      { calc: 'timesheet', name: '5 days 08:30–17:00 with 30-min breaks = 40 h', input: { rate: 22, otAfter: 40 }, expect: { hours: 40, pay: 880 } },
      { pure: 'timesheetHours', name: 'overnight shift 22:00–06:00 = 8 h', run: P => ({ h: P.timesheetHours([{ in: '22:00', out: '06:00', breakMin: 0 }]) }), expect: { h: 8 } },
    ],
  };
});

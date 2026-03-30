interface PremiumDisplayProps {
  term: string;
  premium: number | null;
}

const COVERAGE: Record<string, string> = {
  'Fall':          'August 11 – December 31',
  'Spring/Summer': 'January 1 – August 10',
  'Summer':        'May 11 – August 10',
};

export function PremiumDisplay({ term, premium }: PremiumDisplayProps) {
  if (!premium) return null;
  const termName = term.split(' ')[0];
  const coverage = COVERAGE[termName] ?? '';
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(premium);

  return (
    <div className="premium-box">
      <div className="premium-amount">{formatted}</div>
      <div className="premium-label">Anthem Student Advantage — Blue Access PPO</div>
      {coverage && <div className="premium-coverage">Coverage period: {coverage}</div>}
      <div className="premium-warning">
        This amount will be <strong>deducted from your program's operating budget.</strong>
      </div>
    </div>
  );
}

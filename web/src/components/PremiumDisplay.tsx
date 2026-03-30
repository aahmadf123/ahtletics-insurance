interface PremiumDisplayProps {
  term: string;
  premium: number;
}

export function PremiumDisplay({ term, premium }: PremiumDisplayProps) {
  return (
    <div className="premium-display">
      <div className="premium-plan">
        <strong>Anthem Student Advantage — Blue Access PPO Network</strong>
        <ul className="premium-features">
          <li>$0 deductible at University of Toledo Medical Center (UTMC)</li>
          <li>Sydney Health App access</li>
          <li>LiveHealth Online video visits</li>
          <li>GeoBlue global emergency coverage</li>
        </ul>
      </div>
      <div className="premium-cost">
        <span className="premium-label">Premium for {term}:</span>
        <span className="premium-amount">${premium.toFixed(2)}</span>
      </div>
      <p className="premium-note">
        This amount will be deducted entirely from your program's operating budget.
      </p>
    </div>
  );
}

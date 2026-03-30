import { useState } from 'react';

interface DisclaimerCheckboxesProps {
  deadline: string;
  onChange: (allChecked: boolean) => void;
}

export function DisclaimerCheckboxes({ deadline, onChange }: DisclaimerCheckboxesProps) {
  const [checked, setChecked] = useState([false, false, false]);

  const toggle = (i: number) => {
    const next = checked.map((v, idx) => (idx === i ? !v : v));
    setChecked(next);
    onChange(next.every(Boolean));
  };

  return (
    <div className="disclaimers">
      <Disclaimer
        checked={checked[0]}
        onToggle={() => toggle(0)}
        label="Budget Deduction Authorization"
        text="By checking this box and applying my digital signature, I acknowledge and authorize that the total cost of the student-athlete health insurance premium for the selected term will be deducted entirely from my program's operating budget. I understand that the central Athletics department will not cover or subsidize this expense under any circumstances."
      />
      <Disclaimer
        checked={checked[1]}
        onToggle={() => toggle(1)}
        label="Submission Deadline Acknowledgment"
        text={`All requests for health insurance enrollment must be fully executed and submitted prior to the start of the semester. The deadline for the upcoming term is ${deadline}. I acknowledge that requests submitted after this date will be automatically rejected by the system.`}
      />
      <Disclaimer
        checked={checked[2]}
        onToggle={() => toggle(2)}
        label="Finality of Submission"
        text="I acknowledge that once this request is submitted and the signature routing process begins, no further changes, edits, or retractions can be made to this document. If an error is discovered regarding the student-athlete name or Rocket Number, the request must be formally voided by the Chief Financial Officer and a new request must be initiated."
      />
    </div>
  );
}

function Disclaimer({
  checked, onToggle, label, text,
}: { checked: boolean; onToggle: () => void; label: string; text: string }) {
  return (
    <label className={`disclaimer ${checked ? 'disclaimer--checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="disclaimer-body">
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
    </label>
  );
}

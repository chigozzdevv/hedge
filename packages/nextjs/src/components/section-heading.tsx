import type { ReactNode } from "react";

export function SectionHeading({
  eyebrow,
  children,
  description,
  centered = false,
}: {
  eyebrow?: string;
  children: ReactNode;
  description?: string;
  centered?: boolean;
}) {
  return (
    <div className={`section-heading ${centered ? "mx-auto text-center" : ""}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{children}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
  );
}

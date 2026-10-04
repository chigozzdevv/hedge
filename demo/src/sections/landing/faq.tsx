import { Plus } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { faqs } from "@/lib/site";

export function Faq() {
  return (
    <section id="faqs" className="shell section-space faq-section">
      <SectionHeading eyebrow="A little more clarity" centered>
        Frequently asked
        <br className="sm:hidden" /> questions.
      </SectionHeading>
      <div className="faq-list">
        {faqs.map(({ question, answer }) => (
          <details className="faq-item group" name="hedge-faq" key={question}>
            <summary>
              <h3>{question}</h3>
              <Plus
                size={20}
                className="shrink-0 text-muted transition-transform group-open:rotate-45"
                aria-hidden="true"
              />
            </summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

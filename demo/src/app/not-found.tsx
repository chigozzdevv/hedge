import { ActionLink } from "@/components/action-link";

export default function NotFound() {
  return (
    <main id="main-content" className="shell interior-page">
      <p className="eyebrow">404</p>
      <h1>
        This page took
        <br />a different route.
      </h1>
      <p className="section-description">Head back to Hedge to find what you need.</p>
      <ActionLink href="/" className="mt-8">
        Back to Hedge
      </ActionLink>
    </main>
  );
}

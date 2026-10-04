"use client";

import { useEffect, useState } from "react";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "setup", label: "Setup" },
  { id: "integration", label: "React integration" },
  { id: "protocol", label: "Protocol rules" },
  { id: "evidence", label: "Test evidence" },
] as const;

export function GuideNav() {
  const [active, setActive] = useState<string>(sections[0].id);

  useEffect(() => {
    const headings = sections.map(({ id }) => document.getElementById(id));
    let frame = 0;

    function update() {
      frame = 0;
      const offset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 110;
      let current: string = sections[0].id;
      headings.forEach((heading, index) => {
        if (heading && heading.getBoundingClientRect().top <= offset + 24)
          current = sections[index].id;
      });
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2)
        current = sections[sections.length - 1].id;
      setActive(current);
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, []);

  return (
    <nav className="guide-nav" aria-label="Documentation sections">
      {sections.map(({ id, label }) => (
        <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

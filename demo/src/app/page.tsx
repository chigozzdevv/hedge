import { Hero } from "@/sections/landing/hero";
import { Networks } from "@/sections/landing/networks";
import { WhyHedge } from "@/sections/landing/why-hedge";
import { HowItWorks } from "@/sections/landing/how-it-works";
import { Developers } from "@/sections/landing/developers";
import { Demo } from "@/sections/landing/demo";
import { Faq } from "@/sections/landing/faq";
import { Closing } from "@/sections/landing/closing";

export default function LandingPage() {
  return (
    <main id="main-content">
      <Hero />
      <Networks />
      <WhyHedge />
      <HowItWorks />
      <Developers />
      <Demo />
      <Faq />
      <Closing />
    </main>
  );
}

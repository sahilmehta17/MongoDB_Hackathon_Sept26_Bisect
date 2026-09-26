// Plain-language titles for the planted demo cases, keyed by the seed id of the planted lesson.
export const CASE_COPY: Record<string, { title: string; blurb: string }> = {
  H1: {
    title: "The retry that refunds twice",
    blurb: "The agent learned to retry any call that times out. When a refund times out after it already went through, it refunds the customer a second time.",
  },
  H2: {
    title: "The loyal-customer exception",
    blurb: "The agent learned that loyal customers get a longer return window, and now refunds regular customers after the window has closed.",
  },
  H3: {
    title: "The email shortcut",
    blurb: "The agent learned that a matching email means the customer is verified, and now redirects shipped packages without the verification code.",
  },
};

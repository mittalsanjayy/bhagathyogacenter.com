(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const animatedSelectors = [
    ".section-heading",
    ".story-photo",
    ".story-copy",
    ".principle",
    ".program-row",
    ".schedule-list",
    ".section-benefits > *",
    ".section-instructor > *",
    ".section-reviews > *",
    ".details-heading",
    ".details-grid > *",
    ".transformation-heading",
    ".transformation-card",
    ".gallery-top",
    ".gallery-grid > .gallery-item",
    ".pricing-copy",
    ".home-plan-card",
    ".contact-copy",
    ".enquiry-form",
    ".final-cta-inner",
    ".footer-main > *",
    ".footer-bottom",
    ".plan-card",
    ".payment-stories-heading",
    ".payment-photo-card",
    ".payment-testimonials-heading",
    ".payment-testimonial-card",
    ".payment-details",
    ".payment-reassurance"
  ];

  document.querySelectorAll(animatedSelectors.join(",")).forEach(element => {
    element.classList.add("reveal");
  });

  const revealElements = [...document.querySelectorAll(".reveal")];
  if (reducedMotion) {
    revealElements.forEach(element => element.classList.add("is-visible"));
    return;
  }

  let observer;
  let fallbackTimer;
  let scrollFrame;
  let schedulePassedElementCheck;
  const revealAll = () => {
    window.clearTimeout(fallbackTimer);
    window.cancelAnimationFrame(scrollFrame);
    observer?.disconnect();
    if (schedulePassedElementCheck) {
      window.removeEventListener("scroll", schedulePassedElementCheck);
      window.removeEventListener("resize", schedulePassedElementCheck);
    }
    revealElements.forEach(element => element.classList.add("is-visible"));
  };

  if ("IntersectionObserver" in window) {
    const revealPassedElements = () => {
      scrollFrame = undefined;
      revealElements.forEach(element => {
        if (element.classList.contains("is-visible")) return;
        if (element.getBoundingClientRect().top > window.innerHeight + 160) return;
        element.classList.add("is-visible");
        observer.unobserve(element);
      });
    };
    schedulePassedElementCheck = () => {
      if (scrollFrame !== undefined) return;
      scrollFrame = window.requestAnimationFrame(revealPassedElements);
    };

    observer = new IntersectionObserver((entries, currentObserver) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        currentObserver.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px 160px 0px", threshold: 0.01 });
    revealElements.forEach(element => observer.observe(element));
    document.documentElement.classList.add("js");
    fallbackTimer = window.setTimeout(revealAll, 2500);
    window.addEventListener("scroll", schedulePassedElementCheck, { passive: true });
    window.addEventListener("resize", schedulePassedElementCheck, { passive: true });
    window.addEventListener("pageshow", event => {
      if (event.persisted) revealAll();
    });
  } else {
    revealAll();
  }

  if (!window.gsap || !window.ScrollTrigger) return;

  window.gsap.registerPlugin(window.ScrollTrigger);
  window.gsap.context(() => {
    const { gsap, ScrollTrigger } = window;

    const hero = document.querySelector(".hero");
    if (hero) {
      const heroCopy = [
        hero.querySelector(".eyebrow"),
        hero.querySelector("h1"),
        hero.querySelector(".hero-intro"),
        hero.querySelector(".hero-actions"),
        hero.querySelector(".hero-location")
      ].filter(Boolean);

      gsap.from(heroCopy, {
        y: 24,
        duration: 0.9,
        stagger: 0.13,
        ease: "power3.out",
        clearProps: "transform"
      });

      const wideMotion = gsap.matchMedia();
      wideMotion.add("(min-width: 760px)", () => {
        const editorialPhotos = gsap.utils.toArray(".section-story .story-photo img, .section-details .visit-photo img");
        editorialPhotos.forEach(image => {
          gsap.fromTo(image, { yPercent: -3 }, {
            yPercent: 3,
            ease: "none",
            scrollTrigger: { trigger: image, start: "top bottom", end: "bottom top", scrub: 1.2 }
          });
        });

        const gallery = document.querySelector(".gallery-grid");
        if (gallery) {
          gsap.fromTo(gallery, { x: -8 }, {
            x: 8,
            ease: "none",
            scrollTrigger: { trigger: gallery, start: "top bottom", end: "bottom top", scrub: 1.2 }
          });
        }
      });

      const magneticMotion = gsap.matchMedia();
      magneticMotion.add("(min-width: 921px) and (hover: hover) and (pointer: fine)", () => {
        const controller = new AbortController();
        const buttons = hero.querySelectorAll(".hero-actions .button");
        buttons.forEach(button => {
          const moveX = gsap.quickTo(button, "x", { duration: 0.32, ease: "power3.out" });
          const moveY = gsap.quickTo(button, "y", { duration: 0.32, ease: "power3.out" });
          button.addEventListener("pointermove", event => {
            const bounds = button.getBoundingClientRect();
            moveX(Math.max(-5, Math.min(5, (event.clientX - bounds.left - bounds.width / 2) * 0.12)));
            moveY(Math.max(-5, Math.min(5, (event.clientY - bounds.top - bounds.height / 2) * 0.12)));
          }, { signal: controller.signal });
          button.addEventListener("pointerleave", () => {
            moveX(0);
            moveY(0);
          }, { signal: controller.signal });
        });
        return () => controller.abort();
      });
    }
  });
})();

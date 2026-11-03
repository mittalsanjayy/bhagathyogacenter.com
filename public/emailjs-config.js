(() => {
  "use strict";

  const serviceId = "service_rvud4nv";
  const templateId = "template_cgth5ei";
  const publicKey = "hAbqj_wCIDIb3eAan";
  const recipientEmail = "vrshkanthi@gmail.com";
  let initialized = false;

  async function send(form) {
    if (!window.emailjs || typeof window.emailjs.send !== "function") {
      throw new Error("EmailJS is unavailable.");
    }

    if (!initialized) {
      window.emailjs.init({ publicKey });
      initialized = true;
    }

    const formData = Object.fromEntries(new FormData(form).entries());
    const response = await window.emailjs.send(serviceId, templateId, {
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      interest: formData.interest,
      message: formData.message,
      to_email: recipientEmail,
    });

    if (!response || response.status !== 200) {
      throw new Error("EmailJS did not confirm successful delivery.");
    }

    return response;
  }

  window.BHAGATH_EMAILJS = Object.freeze({ send });
})();

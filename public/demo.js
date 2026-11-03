(() => {
  "use strict";

  const form = document.getElementById("demoForm");
  const confirmation = document.getElementById("confirmation");
  const nameInput = document.getElementById("name");
  const phoneInput = document.getElementById("phone");
  const emailInput = document.getElementById("email");
  const dateInput = document.getElementById("date");
  const timeInput = document.getElementById("time");
  const messageInput = document.getElementById("message");
  const submitButton = document.getElementById("submitButton");
  const submitButtonDefault = submitButton.innerHTML;
  const successMessage = "Thank you! Your enquiry has been sent successfully. We will contact you soon.";

  function getToday() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  dateInput.min = getToday();
  let submitting = false;

  function showStatus(text, state) {
    confirmation.hidden = false;
    confirmation.textContent = text;
    confirmation.dataset.state = state;
  }

  form.addEventListener("input", () => {
    confirmation.hidden = true;
    confirmation.removeAttribute("data-state");
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting) return;

    nameInput.value = nameInput.value.trim();
    emailInput.value = emailInput.value.trim();
    phoneInput.value = phoneInput.value.trim();
    messageInput.value = messageInput.value.trim();

    if (!form.reportValidity()) return;

    if (!/^[6-9][0-9]{9}$/.test(phoneInput.value)) {
      phoneInput.setCustomValidity("Enter a valid 10-digit Indian mobile number.");
      phoneInput.reportValidity();
      phoneInput.setCustomValidity("");
      return;
    }

    const selectedDay = new Date(`${dateInput.value}T12:00:00`).getDay();
    if (selectedDay === 0 || selectedDay === 6) {
      showStatus("Demo sessions are available Monday to Friday only. Please select another date.", "error");
      dateInput.focus();
      return;
    }

    submitting = true;
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    form.setAttribute("aria-busy", "true");
    submitButton.textContent = "Sending request...";
    showStatus("Sending your enquiry...", "sending");

    try {
      await window.BHAGATH_EMAILJS.send(form);
      showStatus(successMessage, "success");
      form.reset();
      dateInput.min = getToday();
    } catch (error) {
      console.error("EmailJS demo request submission failed:", error);
      showStatus("We couldn't send your enquiry right now. Please try again or contact Bhagath Yoga Center directly.", "error");
    } finally {
      submitting = false;
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
      form.removeAttribute("aria-busy");
      submitButton.innerHTML = submitButtonDefault;
    }
  });
})();

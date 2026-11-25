import { sendFeedback } from './feedback.js';

const form = document.querySelector('#feedback');
const done = document.querySelector('#thanks');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await sendFeedback({
      kind: data.get('kind'),
      rating: data.get('rating') ? Number(data.get('rating')) : null,
      message: data.get('message'),
      email: data.get('email') || null,
      website: data.get('website'), // honeypot, left empty by people
    });
    form.hidden = true;
    done.hidden = false;
  } catch {
    button.disabled = false;
    done.hidden = false;
    done.textContent = 'Sorry, that did not send. Please try again in a minute.';
  }
});

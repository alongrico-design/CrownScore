/* ==========================================================================
   CrownScore.js - Core Authentication, Forgot Password & Session Router
   ========================================================================== */

const API_BASE_URL = 'https://donor-hurry-blatancy.ngrok-free.dev/api';

document.addEventListener('DOMContentLoaded', () => {

  /* ------------------------------------------------------------------------
     1. USER REGISTRATION LOGIC
     ------------------------------------------------------------------------ */
  const registerForm = document.getElementById('register-form');

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const confirmPass = document.getElementById('confirmpass').value;
      const recoveryQuestion = document.getElementById('recovery-question').value.trim();
      const recoveryAnswer = document.getElementById('recovery-answer').value.trim();

      if (password !== confirmPass) {
        alert('Passwords do not match!');
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password,
            recoveryQuestion,
            recoveryAnswer
          })
        });

        const data = await response.json();

        if (response.ok) {
          alert('Registration successful! Redirecting to login...');
          window.location.href = 'index.html';
        } else {
          alert(data.message || 'Registration failed.');
        }
      } catch (error) {
        console.error('Registration error:', error);
        alert('Server connection error. Please make sure server.js is running.');
      }
    });
  }

  /* ------------------------------------------------------------------------
     2. USER LOGIN LOGIC
     ------------------------------------------------------------------------ */
  const loginForm = document.getElementById('login-form');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const errorEl = document.getElementById('login-error');
      if (errorEl) { errorEl.hidden = true; errorEl.textContent = ''; }

      const usernameInput = document.getElementById('username').value.trim();
      const passwordInput = document.getElementById('password').value.trim();

      if (!usernameInput || !passwordInput) {
        if (errorEl) {
          errorEl.textContent = 'Please provide both username and password.';
          errorEl.hidden = false;
        } else {
          alert('Please provide both username and password.');
        }
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: usernameInput, password: passwordInput })
        });

        const data = await response.json();

        if (!response.ok) {
          if (errorEl) {
            errorEl.textContent = data.message || 'Invalid username or password.';
            errorEl.hidden = false;
          } else {
            alert(data.message || 'Login failed.');
          }
          return;
        }

        // Store user details in local storage for session management
        const userObj = {
          id: data.user.id || data.user.user_id,
          username: data.user.username
        };

        localStorage.setItem('currentUser', JSON.stringify(userObj));
        localStorage.setItem('loggedInUser', userObj.username);

        window.location.href = 'Profile.html';

      } catch (err) {
        console.error('Login error:', err);
        if (errorEl) {
          errorEl.textContent = 'Server connection error. Make sure server.js is running.';
          errorEl.hidden = false;
        } else {
          alert('Server connection error. Make sure server.js is running.');
        }
      }
    });
  }

  /* ------------------------------------------------------------------------
     3. FORGOT PASSWORD SUBMISSION LOGIC
     ------------------------------------------------------------------------ */
  const forgotForm = document.getElementById('forgotpassword-form');

  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const panel = document.getElementById('reset-panel');
      
      // If panel is still hidden, Step 1 (Find account) is active, do not execute final submit
      if (panel && panel.hidden) return;

      const username = document.getElementById('username').value.trim();
      const recoveryAnswer = document.getElementById('recovery-answer').value.trim();
      const newPassword = document.getElementById('new-password').value;
      const confirmPassword = document.getElementById('confirm-password').value;

      if (newPassword !== confirmPassword) {
        alert('New passwords do not match!');
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            recoveryAnswer,
            newPassword
          })
        });

        const data = await response.json();

        if (response.ok) {
          alert('Password reset successful! Redirecting to login page...');
          window.location.href = 'index.html';
        } else {
          alert(data.message || 'Password reset failed.');
        }
      } catch (error) {
        console.error('Password reset error:', error);
        alert('Server connection error. Make sure server.js is running.');
      }
    });
  }

  /* ------------------------------------------------------------------------
     4. SESSION PROTECTION & HOME DISPLAY
     ------------------------------------------------------------------------ */
  const userDisplay = document.getElementById('user-display');
  const logoutBtn = document.getElementById('logout-btn');

  if (userDisplay && logoutBtn) {
    const loggedInUser = localStorage.getItem('loggedInUser');

    if (!loggedInUser) {
      alert('Please log in first to access CrownScore!');
      window.location.href = 'index.html';
      return;
    }

    userDisplay.textContent = loggedInUser;

    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('currentUser');
      localStorage.removeItem('loggedInUser');
      alert('Logged out successfully.');
      window.location.href = 'index.html';
    });
  }

});
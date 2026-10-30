// Accessible password visibility toggles for sign-in and registration.
// No password content is logged, copied or persisted by this helper.
(function () {
  'use strict';
  function mount() {
    for(const input of document.querySelectorAll('input[type="password"]')) {
      if(!['password','passwordConfirm'].includes(input.id) || input.dataset.visibilityReady)continue;
      input.dataset.visibilityReady='1';
      const toggle=document.createElement('button');
      toggle.type='button';
      toggle.className='btn ghost sm password-visibility';
      toggle.textContent='Show password';
      toggle.setAttribute('aria-label','Show '+(input.id==='passwordConfirm'?'confirmation password':'password'));
      toggle.setAttribute('aria-controls',input.id);
      toggle.setAttribute('aria-pressed','false');
      toggle.onclick=()=>{
        const visible=input.type==='password';
        input.type=visible?'text':'password';
        toggle.textContent=visible?'Hide password':'Show password';
        toggle.setAttribute('aria-label',(visible?'Hide ':'Show ')+(input.id==='passwordConfirm'?'confirmation password':'password'));
        toggle.setAttribute('aria-pressed',String(visible));
      };
      input.insertAdjacentElement('afterend',toggle);
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();

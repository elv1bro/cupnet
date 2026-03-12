



let _lastMouseReport = 0;
document.addEventListener('mousemove', () => {
  const now = Date.now();
  if (now - _lastMouseReport > 5000) {
    _lastMouseReport = now;
    window.electronAPI.reportMouseActivity();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  
  const proxyInput = document.getElementById('proxy-url');
  const applyButton = document.getElementById('apply-btn');
  const cancelButton = document.getElementById('cancel-btn');
  const validationMessage = document.getElementById('validation-message');
  const statusMessage = document.getElementById('status-message');
  const spinner = document.getElementById('spinner');
  
  
  proxyInput.focus();
  
  
  window.electronAPI.getCurrentProxy().then(currentProxy => {
    
    proxyInput.value = currentProxy || '';
  });
  
  
  function showProxyInfo(url) {
    if (!url || url.trim() === '') {
      return;
    }
    
    
    validationMessage.textContent = 'Proxy format will not be validated';
    validationMessage.className = 'validation-message';
    validationMessage.classList.add('success');
  }
  
  
  function showStatusMessage(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = 'status-message';
    statusMessage.classList.add(type);
  }
  
  
  function clearStatusMessage() {
    statusMessage.textContent = '';
    statusMessage.className = 'status-message';
  }
  
  
  function setLoading(isLoading) {
    if (isLoading) {
      spinner.style.display = 'block';
      applyButton.disabled = true;
    } else {
      spinner.style.display = 'none';
      applyButton.disabled = false;
    }
  }
  
  
  proxyInput.addEventListener('input', () => {
    clearStatusMessage();
  });
  
  
  applyButton.addEventListener('click', () => {
    const newProxyUrl = proxyInput.value.trim();
    
    if (!newProxyUrl) {
      showStatusMessage('Please enter a proxy URL', 'error');
      return;
    }
    
    
    setLoading(true);
    clearStatusMessage();
    
    
    window.electronAPI.applyQuickProxyChange(newProxyUrl)
      .then(result => {
        if (result.success) {
          
          showStatusMessage(result.message || 'Anonymized proxy created successfully!', 'success');
          setTimeout(() => {
            window.close();
          }, 1000);
        } else {
          
          setLoading(false);
          showStatusMessage(`Failed to change proxy: ${result.error || 'Unknown error'}`, 'error');
        }
      })
      .catch(error => {
        
        setLoading(false);
        showStatusMessage(`Failed to change proxy: ${error.message || 'Unknown error'}`, 'error');
      });
  });
  
  
  cancelButton.addEventListener('click', () => {
    window.close();
  });
  
  
  proxyInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      applyButton.click();
    } else if (event.key === 'Escape') {
      cancelButton.click();
    }
  });
});

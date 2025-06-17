document.addEventListener('DOMContentLoaded', () => {
  const domainInput = document.getElementById('domainInput');
  const searchBtn = document.getElementById('searchBtn');
  const exampleLinks = document.querySelectorAll('.example-link');
  const statusIndicator = document.getElementById('status-indicator');
  
  // Check server status
  checkServerStatus();
  
  // Search button click handler
  searchBtn.addEventListener('click', () => {
    navigateToHnsDomain();
  });
  
  // Enter key press handler
  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      navigateToHnsDomain();
    }
  });
  
  // Example link click handlers
  exampleLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const domain = e.target.getAttribute('data-domain');
      domainInput.value = domain;
      navigateToHnsDomain();
    });
  });
  
  // Function to navigate to HNS domain (using new URL format)
  function navigateToHnsDomain() {
    const domain = domainInput.value.trim();
    
    if (!domain) {
      alert('Please enter a Handshake domain');
      return;
    }
    
    // Clean up domain input (remove trailing slashes)
    const cleanDomain = domain.replace(/\/+$/, '');
    
    // Navigate to the HNS domain using new format
    window.location.href = `/${cleanDomain}`;
  }
  
  // Check server status
  async function checkServerStatus() {
    try {
      const response = await fetch('/api/status');
      const data = await response.json();
      
      if (data.status === 'online') {
        statusIndicator.textContent = 'Online';
        statusIndicator.classList.add('online');
      } else {
        statusIndicator.textContent = 'Degraded';
        statusIndicator.classList.add('offline');
      }
    } catch (error) {
      statusIndicator.textContent = 'Offline';
      statusIndicator.classList.add('offline');
      console.error('Error checking server status:', error);
    }
  }
});

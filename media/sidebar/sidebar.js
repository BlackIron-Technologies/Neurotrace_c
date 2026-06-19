const vscode = acquireVsCodeApi();
        const thoughtsContainer = document.getElementById('thoughts-list');
        const initialStateContainer = document.getElementById('initial-state');
        const unlockScreen = document.getElementById('unlock-screen');
        const passphraseInput = document.getElementById('passphrase-input');
        const unlockButton = document.getElementById('unlock-button');
        const unlockCodexButton = document.getElementById('unlock-codex-button');
        const searchContainer = document.getElementById('search-container');
        const backButton = document.getElementById('back-button');
        const searchInput = document.getElementById('search-input');
        const textSearchButton = document.getElementById('text-search');
        const semanticSearchButton = document.getElementById('semantic-search');
        const searchTitle = document.getElementById('search-title');
        const filterButton = document.getElementById('filter-by-type');
        const filterDropdown = document.getElementById('filter-dropdown');
        const activeFilterText = document.getElementById('active-filter');
        const addThoughtButton = document.getElementById('add-thought-button');
        const backendStatus = document.getElementById('backend-status');
        const downloadBackendButton = document.getElementById('download-backend-button');
        let isFilterActive = false;
        let currentFilterType = null;
        let currentDbState = 'UNKNOWN'; // Track current DB state to prevent backendStatus from overriding LOADING state

        // Backend download button listener
        if (downloadBackendButton) {
          downloadBackendButton.addEventListener('click', () => {
            // Disable button and change text
            downloadBackendButton.disabled = true;
            downloadBackendButton.textContent = 'Downloading...';
            downloadBackendButton.style.opacity = '0.6';
            downloadBackendButton.style.cursor = 'not-allowed';
            vscode.postMessage({ type: 'downloadBackend' });
          });
        }

        // Multi-select state
        const selectedThoughts = new Set();
        const deleteSelectedContainer = document.getElementById('delete-selected-container');
        const deleteSelectedInfo = document.getElementById('delete-selected-info');
        const deleteSelectedButton = document.getElementById('delete-selected-button');
        const confirmationModal = document.getElementById('confirmation-modal');
        const confirmationMessage = document.getElementById('confirmation-message');
        const cancelDeleteButton = document.getElementById('cancel-delete');
        const confirmDeleteButton = document.getElementById('confirm-delete');

        // Variables for pagination
        let currentPage = 0;
        let totalPages = 1;

        // Configure search listeners
        textSearchButton.addEventListener('click', () => {
          const searchTerm = searchInput.value.trim();
          if (searchTerm) {
            vscode.postMessage({ type: 'search', searchTerm });
          }
        });
        
        semanticSearchButton.addEventListener('click', () => {
          const searchTerm = searchInput.value.trim();
          if (searchTerm) {
            vscode.postMessage({ type: 'semanticSearch', searchTerm });
          }
        });
        
        searchInput.addEventListener('keyup', (e) => {
          if (e.key === 'Enter') {
            const searchTerm = searchInput.value.trim();
            if (searchTerm) {
              vscode.postMessage({ type: 'search', searchTerm });
            }
          }
        });

        // Add thought button listener
        addThoughtButton.addEventListener('click', () => {
          vscode.postMessage({ type: 'addThought' });
        });

        // Multi-select functionality
        function updateDeleteSelectedBar() {
          const count = selectedThoughts.size;
          if (count > 0) {
            deleteSelectedInfo.textContent = `${count} selected`;
            deleteSelectedContainer.classList.add('show');
          } else {
            deleteSelectedContainer.classList.remove('show');
          }
        }

        function handleCheckboxChange(thoughtId, isChecked) {
          if (isChecked) {
            selectedThoughts.add(thoughtId);
          } else {
            selectedThoughts.delete(thoughtId);
          }
          updateDeleteSelectedBar();
        }

        deleteSelectedButton.addEventListener('click', () => {
          const count = selectedThoughts.size;
          if (count === 0) return;
          
          confirmationMessage.textContent = `Are you sure you want to delete ${count} memor${count > 1 ? 'ies' : 'y'}? This action cannot be undone.`;
          confirmationModal.classList.add('show');
        });

        cancelDeleteButton.addEventListener('click', () => {
          confirmationModal.classList.remove('show');
          pendingSingleDelete = null; // Clear single delete pending
        });

        confirmDeleteButton.addEventListener('click', () => {
          // Check if this is a single delete or multiple delete
          if (pendingSingleDelete) {
            // Single delete
            vscode.postMessage({ type: 'delete', id: pendingSingleDelete });
            pendingSingleDelete = null;
          } else if (selectedThoughts.size > 0) {
            // Multiple delete
            const thoughtsToDelete = Array.from(selectedThoughts);
            vscode.postMessage({ type: 'deleteMultiple', ids: thoughtsToDelete });
            selectedThoughts.clear();
            updateDeleteSelectedBar();
          }
          confirmationModal.classList.remove('show');
        });

        // Close modal on background click
        confirmationModal.addEventListener('click', (e) => {
          if (e.target === confirmationModal) {
            confirmationModal.classList.remove('show');
            pendingSingleDelete = null; // Clear single delete pending
          }
        });

        const unlock = () => {
          const password = passphraseInput.value.trim();
          if (password && !passphraseInput.disabled) {
            const errorMessageEl = document.getElementById('unlock-error-message');
            if (errorMessageEl) {
              errorMessageEl.style.display = 'none';
            }
            vscode.postMessage({ type: 'unlock', password });
            passphraseInput.value = '';
          }
        };

        unlockButton.addEventListener('click', unlock);
        unlockCodexButton.addEventListener('click', () => {
          vscode.postMessage({ type: 'unlockForCodex' });
        });
        
        passphraseInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            unlock();
          }
        });
        
        filterButton.addEventListener('click', (event) => {
          // Toggle the dropdown display
          filterDropdown.classList.toggle('show');
          
          if (filterDropdown.classList.contains('show')) {
            const buttonRect = filterButton.getBoundingClientRect();
            const parentContainer = document.querySelector('.search-buttons');
            const parentRect = parentContainer ? parentContainer.getBoundingClientRect() : null;
            
            // Calculate horizontal position - align right edge with right edge of button
            filterDropdown.style.right = '0';
            filterDropdown.style.left = 'auto';
            
            // Set a reasonable width that works for all items
            filterDropdown.style.minWidth = '120px';
            
            // Make sure the dropdown doesn't overflow the sidebar
            const sidebar = document.querySelector('body');
            if (sidebar) {
              const sidebarWidth = sidebar.clientWidth;
              filterDropdown.style.maxWidth = '${sidebarWidth - 20}px';
            }
          }
          
          event.stopPropagation();
        });

        // Close the filter dropdown if clicking outside of it
        document.addEventListener('click', (event) => {
          if (!filterButton.contains(event.target) && !filterDropdown.contains(event.target)) {
            filterDropdown.classList.remove('show');
          }
        });
        
        // Handle filter type selection
        document.querySelectorAll('.filter-item').forEach(item => {
          item.addEventListener('click', () => {
            const selectedType = item.getAttribute('data-type');
            
            // Remove active class from all items
            document.querySelectorAll('.filter-item').forEach(i => {
              i.classList.remove('active');
            });
            
            // Apply the filter
            if (selectedType === 'all') {
              vscode.postMessage({ type: 'filterByType', thoughtType: null });
              filterButton.classList.remove('active');
              activeFilterText.style.display = 'none';
              currentFilterType = null;
              isFilterActive = false;
            } else {
              item.classList.add('active');
              vscode.postMessage({ type: 'filterByType', thoughtType: selectedType });
              filterButton.classList.add('active');
              activeFilterText.style.display = 'block';
              activeFilterText.textContent = 'Filtered by type: ' + selectedType;
              currentFilterType = selectedType;
              isFilterActive = true;
            }
            
            filterDropdown.classList.remove('show');
          });
        });

        // Handle menu item clicks
        document.getElementById('encrypt-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'encrypt' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });
        document.getElementById('decrypt-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'decrypt' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });
        document.getElementById('advanced-export-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'advanced-export' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });
        document.getElementById('open-graph-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'open-graph' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });
        document.getElementById('instruction-sync-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'open-instruction-sync' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });

        document.getElementById('advanced-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'advanced' });
          document.getElementById('dropdown-menu').classList.remove('show');
        });

        // Button to go back to all thoughts
        backButton.addEventListener('click', () => {
          // Reset filter state when going back
          filterButton.classList.remove('active');
          activeFilterText.style.display = 'none';
          currentFilterType = null;
          isFilterActive = false;
          
          vscode.postMessage({ type: 'restoreOriginal' });
        });

        // Global variables to track local feature state
        let currentUserProfile = null;
        let isCurrentlyLoggedIn = false;
        let currentFeatureAccess = true;

        function updateFeatureButtonStates() {
          // Update semantic search button
          const semanticSearchBtn = document.getElementById('semantic-search');
          if (semanticSearchBtn) {
            semanticSearchBtn.title = 'Semantic AI search';
          }
          
          // Update open graph button
          const openGraphBtn = document.getElementById('open-graph-button');
          if (openGraphBtn) {
            openGraphBtn.title = 'Open Memory Graph';
          }
          
          // Update all suggest buttons in thoughts
          const suggestButtons = document.querySelectorAll('.suggest-btn');
          suggestButtons.forEach(btn => {
            btn.title = 'Suggest Related';
          });
        }

        function formatTypeLabel(type) {
          if (!type) return 'Note';
          return String(type)
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (match) => match.toUpperCase());
        }

        function formatTaskStatus(status) {
          if (!status) return 'Open';
          return String(status)
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (match) => match.toUpperCase());
        }

        function createThoughtElement(thought) {
          const el = document.createElement('div');
          el.className = 'thought';
          el.id = 'thought-' + thought.id;
          
          const escape = (str) => String(str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

          const suggestDisabled = '';

          const priorityValue = (thought.priority ?? '').toString();
          const priorityKey = priorityValue.trim().toLowerCase();
          let priorityClass = 'priority-default';
          if (priorityKey === 'high') {
            priorityClass = 'priority-high';
          } else if (priorityKey === 'moderate' || priorityKey === 'medium') {
            priorityClass = 'priority-moderate';
          } else if (priorityKey === 'low') {
            priorityClass = 'priority-low';
          }
          
          // Create the header (always visible) - Type and buttons
          const header = document.createElement('div');
          header.className = 'thought-header';
          header.innerHTML = `
            <div style="display: flex; align-items: center;">
              <input type="checkbox" class="thought-checkbox" data-thought-id="${thought.id}" onclick="event.stopPropagation()">
              <span class="thought-expander">▶</span>
              <span class="thought-type" title="${escape(thought.text)}">${escape(formatTypeLabel(thought.type || 'Note'))}</span>
            </div>
            <div class="thought-actions">
              <button class="suggest-btn" onclick="event.stopPropagation(); suggest('${thought.id}')" title="Suggest Related">🔗</button>
              <button onclick="event.stopPropagation(); edit('${thought.id}')" title="Edit">✏️</button>
              <button onclick="event.stopPropagation(); deleteThought('${thought.id}')" title="Delete">🗑️</button>
            </div>
          `;
          
          // Create the content (initially hidden)
          const content = document.createElement('div');
          content.className = 'thought-content';
          const taskStatusClass = String(thought.status || 'open').toLowerCase().replace(/[^a-z-]/g, '-');
          content.innerHTML = `
            ${thought.type === 'task' ? `<div class="thought-status status-${taskStatusClass}">Status: ${escape(formatTaskStatus(thought.status || 'open'))}</div>` : ''}
            ${thought.type === 'task' && thought.priority ? `<div class="thought-priority ${priorityClass}"><span class="priority-dot"></span><span class="priority-label-text">Priority: ${escape(priorityValue)}</span></div>` : ''}
            <div class="thought-text">${escape(thought.text)}</div>
            <div class="thought-meta">
              <span>${new Date(thought.timestamp).toLocaleString()}</span>
              ${thought.file_path ? `<button class="file-link" onclick="event.stopPropagation(); openFile('${thought.id}')" title="${escape(thought.file_path)}:${thought.line}">${escape(thought.file_path)}:${thought.line}</button>` : ''}
              ${thought.tags ? '<span>🏷️ ' + escape(thought.tags) + '</span>' : ''}
            </div>
            ${thought.snippet ? '<pre class="thought-snippet">' + escape(thought.snippet) + '</pre>' : ''}
          `;
          
          // Add elements to the thought
          el.appendChild(header);
          el.appendChild(content);
          
          // Add checkbox listener
          const checkbox = el.querySelector('.thought-checkbox');
          checkbox.addEventListener('change', (e) => {
            handleCheckboxChange(thought.id, e.target.checked);
          });
          
          // Handle expansion/collapse on click
          header.addEventListener('click', (e) => {
            // Don't toggle if clicking checkbox
            if (e.target.classList.contains('thought-checkbox')) return;
            
            el.classList.toggle('expanded');
            const expander = el.querySelector('.thought-expander');
            if (el.classList.contains('expanded')) {
              expander.textContent = '▼'; // Arrow pointing down when expanded
            } else {
              expander.textContent = '▶'; // Arrow pointing right when collapsed
            }
          });
          
          return el;
        }

        // Decodes error messages to handle special characters
        function decodeErrorMessage(message) {
          try {
            return decodeURIComponent(String(message || ''));
          } catch (e) {
            return String(message || '');
          }
        }

        function showInitialState(type, message) {
          if (type !== 'clear') {
            thoughtsContainer.innerHTML = '';
          }		
          if (type === 'no-db') {
            initialStateContainer.innerHTML = `<p>Database not found.</p><button onclick="vscode.postMessage({ type: 'init' })">Initialize NeuroTrace</button>`;
            searchContainer.style.display = 'none';
          } else if (type === 'no-thoughts') {
            initialStateContainer.innerHTML = '<p>No memories yet. Open a file and add one with Alt+N, or ask the agent to add one for you.</p>';
            searchContainer.style.display = 'none';
          } else if (type === 'error') {
            // Decode the error message before displaying it
            const decodedMessage = decodeErrorMessage(message);
            initialStateContainer.innerHTML = `<p style="color:var(--vscode-errorForeground);">${escape(decodedMessage)}</p>`;
            searchContainer.style.display = 'none';
          } else {
            initialStateContainer.innerHTML = '';
          }
        }

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.type) {
            case 'downloadStatus':
              if (downloadBackendButton) {
                if (message.status === 'downloading') {
                  downloadBackendButton.disabled = true;
                  downloadBackendButton.textContent = 'Downloading...';
                  downloadBackendButton.style.opacity = '0.6';
                  downloadBackendButton.style.cursor = 'not-allowed';
                } else if (message.status === 'success') {
                  // Backend downloaded, button will be hidden by backendStatus message
                  downloadBackendButton.disabled = false;
                  downloadBackendButton.textContent = 'Download Backend';
                  downloadBackendButton.style.opacity = '1';
                  downloadBackendButton.style.cursor = 'pointer';
                } else if (message.status === 'error') {
                  // Download failed, restore button
                  downloadBackendButton.disabled = false;
                  downloadBackendButton.textContent = 'Retry Download';
                  downloadBackendButton.style.opacity = '1';
                  downloadBackendButton.style.cursor = 'pointer';
                }
              }
              break;

            case 'backendStatus':
              if (backendStatus) {
                const loadingSpinnerForBackend = document.getElementById('loading-spinner');
                
                if (message.available) {
                  backendStatus.style.display = 'none';
                  
                  // If we're in LOADING state, show the spinner now that backend container is hidden
                  if (currentDbState === 'LOADING' && loadingSpinnerForBackend) {
                    loadingSpinnerForBackend.style.display = 'flex';
                  }
                  
                  // Only show search/UI elements if in UNLOCKED or UNENCRYPTED state
                  // LOCKED, NO_DB, LOADING, and UNKNOWN states should NOT show these elements
                  if (currentDbState === 'UNLOCKED' || currentDbState === 'UNENCRYPTED') {
                    if (searchContainer) searchContainer.style.display = 'block';
                  }
                } else {
                  backendStatus.style.display = 'block';
                  // Hide spinner when backend is not available
                  if (loadingSpinnerForBackend) loadingSpinnerForBackend.style.display = 'none';
                  // Hide backend-dependent UI elements when backend is not available
                  if (initialStateContainer) initialStateContainer.style.display = 'none';
                  if (unlockScreen) unlockScreen.style.display = 'none';
                  if (thoughtsContainer) thoughtsContainer.style.display = 'none';
                  if (searchContainer) searchContainer.style.display = 'none';
                  const headerContainer = document.getElementById('header-container');
                  const headerToolbar = document.getElementById('header-toolbar');
                  if (headerContainer) headerContainer.style.display = 'none';
                  if (headerToolbar) headerToolbar.style.display = 'none';
                }
              }
              break;

            case 'updateState':
              // Show/hide appropriate screens based on state
              const headerContainer = document.getElementById('header-container');
              const headerToolbar = document.getElementById('header-toolbar');
              const loadingSpinner = document.getElementById('loading-spinner');
              
              // Update the current DB state
              currentDbState = message.state;
              
              if (message.state === 'LOADING') {
                const loadingText = document.querySelector('#loading-spinner .loading-text');
                if (loadingText) {
                  loadingText.textContent = message.loadingText || 'Loading...';
                }
                // LOADING state: show spinner, hide everything else
                if (loadingSpinner) loadingSpinner.style.display = 'flex';
                unlockScreen.style.display = 'none';
                initialStateContainer.style.display = 'none';
                thoughtsContainer.style.display = 'none';
                searchContainer.style.display = 'none';
                if (headerContainer) headerContainer.style.display = 'none';
                if (headerToolbar) headerToolbar.style.display = 'none';
              } else if (message.state === 'LOCKED') {
                // Hide spinner when leaving LOADING state
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                unlockScreen.style.display = 'block';
                initialStateContainer.style.display = 'none';
                thoughtsContainer.style.display = 'none';
                searchContainer.style.display = 'none';
                if (headerContainer) headerContainer.style.display = 'none';
                if (headerToolbar) headerToolbar.style.display = 'none';
                const encryptButton = document.getElementById('encrypt-button');
                if (encryptButton) encryptButton.style.display = 'none';
                const decryptButton = document.getElementById('decrypt-button');
                if (decryptButton) decryptButton.style.display = 'none';
              } else if (message.state === 'UNKNOWN') {
                // Hide spinner when leaving LOADING state
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                // Only show connection error if backend is available (otherwise it's expected)
                if (message.backendAvailable) {
                  unlockScreen.style.display = 'none';
                  initialStateContainer.style.display = 'block';
                  thoughtsContainer.style.display = 'none';
                  searchContainer.style.display = 'none';
                  if (headerContainer) headerContainer.style.display = 'none';
                  if (headerToolbar) headerToolbar.style.display = 'none';
                  showInitialState('error', 'Unable to connect to NeuroTrace server. Please try restarting VS Code.');
                  const encryptButton = document.getElementById('encrypt-button');
                  if (encryptButton) encryptButton.style.display = 'none';
                  const decryptButton = document.getElementById('decrypt-button');
                  if (decryptButton) decryptButton.style.display = 'none';
                } else {
                  // Backend not available - UI already handled by backendStatus message
                  unlockScreen.style.display = 'none';
                  initialStateContainer.style.display = 'none';
                  thoughtsContainer.style.display = 'none';
                  searchContainer.style.display = 'none';
                  if (headerContainer) headerContainer.style.display = 'none';
                  if (headerToolbar) headerToolbar.style.display = 'none';
                }
              } else if (message.state === 'NO_DB') {
                // Hide spinner when leaving LOADING state
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                unlockScreen.style.display = 'none';
                initialStateContainer.style.display = 'block';
                thoughtsContainer.style.display = 'none';
                searchContainer.style.display = 'none';
                if (headerContainer) headerContainer.style.display = 'none';
                if (headerToolbar) headerToolbar.style.display = 'none';
                showInitialState('no-db');
                const encryptButton = document.getElementById('encrypt-button');
                if (encryptButton) encryptButton.style.display = 'none';
                const decryptButton = document.getElementById('decrypt-button');
                if (decryptButton) decryptButton.style.display = 'none';
              } else if (message.state === 'UNENCRYPTED') {
                // Hide spinner when leaving LOADING state
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                unlockScreen.style.display = 'none';
                initialStateContainer.style.display = 'none';
                thoughtsContainer.style.display = 'block';
                searchContainer.style.display = 'block';
                if (headerContainer) headerContainer.style.display = 'flex';
                if (headerToolbar) headerToolbar.style.display = 'flex';
                const encryptButton = document.getElementById('encrypt-button');
                if (encryptButton) encryptButton.style.display = 'block';
                const decryptButton = document.getElementById('decrypt-button');
                if (decryptButton) decryptButton.style.display = 'none';
              } else if (message.state === 'UNLOCKED') {
                // Hide spinner when leaving LOADING state
                if (loadingSpinner) loadingSpinner.style.display = 'none';
                unlockScreen.style.display = 'none';
                initialStateContainer.style.display = 'none';
                thoughtsContainer.style.display = 'block';
                searchContainer.style.display = 'block';
                if (headerContainer) headerContainer.style.display = 'flex';
                if (headerToolbar) headerToolbar.style.display = 'flex';
                const encryptButton = document.getElementById('encrypt-button');
                if (encryptButton) encryptButton.style.display = 'none';
                const decryptButton = document.getElementById('decrypt-button');
                if (decryptButton) decryptButton.style.display = 'block';
              }
              break;

            case 'lockStatus':
              const lockErrorEl = document.getElementById('unlock-error-message');
              const lockAttemptEl = document.getElementById('attempt-counter');
              const lockPassphraseEl = document.getElementById('passphrase-input');
              const lockUnlockBtn = document.getElementById('unlock-button');
              
              if (message.locked) {
                if (lockPassphraseEl) lockPassphraseEl.disabled = true;
                if (lockUnlockBtn) lockUnlockBtn.disabled = true;
                if (lockErrorEl) {
                  lockErrorEl.textContent = `Database locked due to too many failed attempts. Try again in ${message.remainingMinutes} minutes.`;
                  lockErrorEl.style.display = 'block';
                }
                if (lockAttemptEl) {
                  lockAttemptEl.textContent = 'Database locked. Please wait.';
                  lockAttemptEl.style.color = 'var(--vscode-errorForeground)';
                }
              } else if (message.currentAttempts > 0) {
                if (lockAttemptEl) {
                  lockAttemptEl.textContent = `Attempt ${message.currentAttempts}/5`;
                  lockAttemptEl.style.color = 'var(--vscode-descriptionForeground)';
                }
              }
              break;

            case 'unlockSuccess':
              const successErrorEl = document.getElementById('unlock-error-message');
              const successCounterEl = document.getElementById('attempt-counter');
              const successPassphraseEl = document.getElementById('passphrase-input');
              const successUnlockBtn = document.getElementById('unlock-button');
              
              if (successErrorEl) {
                successErrorEl.style.display = 'none';
                successErrorEl.textContent = '';
              }
              if (successCounterEl) {
                successCounterEl.textContent = '';
              }
              if (successPassphraseEl) {
                successPassphraseEl.disabled = false;
                successPassphraseEl.value = '';
              }
              if (successUnlockBtn) {
                successUnlockBtn.disabled = false;
              }
              break;

            case 'unlockError':
              const errorMessageEl = document.getElementById('unlock-error-message');
              const attemptCounterEl = document.getElementById('attempt-counter');
              const passphraseInputEl = document.getElementById('passphrase-input');
              const unlockButtonEl = document.getElementById('unlock-button');
              
              if (errorMessageEl) {
                errorMessageEl.textContent = message.message;
                errorMessageEl.style.display = 'block';
              }
              
              if (message.locked) {
                if (passphraseInputEl) passphraseInputEl.disabled = true;
                if (unlockButtonEl) unlockButtonEl.disabled = true;
                if (attemptCounterEl) {
                  attemptCounterEl.textContent = 'Database locked. Please wait.';
                  attemptCounterEl.style.color = 'var(--vscode-errorForeground)';
                }
              } else {
                if (attemptCounterEl && message.attemptsRemaining !== undefined) {
                  const currentAttempt = 5 - message.attemptsRemaining;
                  attemptCounterEl.textContent = `Attempt ${currentAttempt}/5`;
                  attemptCounterEl.style.color = 'var(--vscode-descriptionForeground)';
                }
              }
              break;

            case 'load':
              // The 'load' message is now the single source of truth for what to display.
              const headerContainerLoad = document.getElementById('header-container');
              const headerToolbarLoad = document.getElementById('header-toolbar');
              
              if (message.data.length === 0 && message.pagination.current === 0) {
                // If there are no thoughts, show the initial state container and hide the list.
                showInitialState('no-thoughts');
                document.getElementById('thoughts-list').style.display = 'none';
                document.getElementById('initial-state').style.display = 'block';
                document.getElementById('pagination').style.display = 'none';
                // Show header even when no thoughts, as database is ready
                if (headerContainerLoad) headerContainerLoad.style.display = 'flex';
                if (headerToolbarLoad) headerToolbarLoad.style.display = 'flex';
              } else {
                // If there are thoughts, clear the old state, show the list, and hide the initial state container.
                showInitialState('clear');
                thoughtsContainer.innerHTML = ''; // Clear only when there's data to show.
                document.getElementById('thoughts-list').style.display = 'block';
                document.getElementById('initial-state').style.display = 'none';
                searchContainer.style.display = 'block';
                backButton.style.display = 'none';
                searchTitle.style.display = 'none';
                if (!isFilterActive) {
                  activeFilterText.style.display = 'none';
                }
                // Show header when thoughts are loaded
                if (headerContainerLoad) headerContainerLoad.style.display = 'flex';
                if (headerToolbarLoad) headerToolbarLoad.style.display = 'flex';

                message.data.forEach(t => thoughtsContainer.appendChild(createThoughtElement(t)));
                
                updatePagination(message.pagination);
                
                // Update feature access state if provided
                if (message.hasFeatureAccess !== undefined) {
                  currentFeatureAccess = message.hasFeatureAccess;
                }
                
                updateFeatureButtonStates();
              }
              break;
              
            case 'searchResults':
              thoughtsContainer.innerHTML = '';
              showInitialState('clear');

              // Show search results UI
              searchContainer.style.display = 'block';
              backButton.style.display = 'block'; // Show back button
              searchTitle.style.display = 'block'; // Show title
              if (!isFilterActive) {
                activeFilterText.style.display = 'none';
              }

              // Update search text
              const searchTypeText = message.isSemanticSearch ? 'Semantic search' : 'Search';
              searchTitle.textContent = `${searchTypeText} for "${escape(message.searchTerm)}": ${message.data.length} results`;
              
              if (message.data.length === 0) {
                thoughtsContainer.innerHTML = '<p>No results found.</p>';
              } else {
                message.data.forEach(t => thoughtsContainer.appendChild(createThoughtElement(t)));
                
                // Update feature access state if provided
                if (message.hasFeatureAccess !== undefined) {
                  currentFeatureAccess = message.hasFeatureAccess;
                }
                
                updateFeatureButtonStates();
              }
              break;

            case 'fileResults':
              thoughtsContainer.innerHTML = '';
              showInitialState('clear');

              searchContainer.style.display = 'block';
              backButton.style.display = 'block';
              searchTitle.style.display = 'block';
              document.getElementById('pagination').style.display = 'none';
              filterButton.classList.remove('active');
              isFilterActive = false;
              currentFilterType = null;
              activeFilterText.style.display = 'block';
              activeFilterText.textContent = 'Current file: ' + message.filePath;
              searchTitle.textContent = `Current file memories: ${message.count}`;

              if (message.data.length === 0) {
                thoughtsContainer.innerHTML = '<p>No memories linked to this file yet.</p>';
              } else {
                message.data.forEach(t => thoughtsContainer.appendChild(createThoughtElement(t)));
                if (message.hasFeatureAccess !== undefined) {
                  currentFeatureAccess = message.hasFeatureAccess;
                }
                updateFeatureButtonStates();
              }
              break;
              
            case 'add':
              initialStateContainer.innerHTML = '';
              document.getElementById('initial-state').style.display = 'none';
              document.getElementById('thoughts-list').style.display = 'block';
              searchContainer.style.display = 'block'; // Ensure search bar is visible
              const existingThought = document.getElementById('thought-' + message.data.id);
              
              if (existingThought) {
                existingThought.replaceWith(createThoughtElement(message.data));
              } else {
                const newEl = createThoughtElement(message.data);
                thoughtsContainer.prepend(newEl);
                newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
              if (message.pagination) {
                updatePagination(message.pagination);
              }
              
              // Update feature access state if provided
              if (message.hasFeatureAccess !== undefined) {
                currentFeatureAccess = message.hasFeatureAccess;
              }
              
              updateFeatureButtonStates();
              break;
              
            case 'delete':
              const elToDelete = document.getElementById('thought-' + message.id);
              if (elToDelete) {
                elToDelete.remove();
                // Remove from selected set if it was selected
                selectedThoughts.delete(message.id);
                updateDeleteSelectedBar();
              }
              
              // Improved logic for handling deletions
              if (message.isSearchMode) {
                // If we are in search mode, maintain the search context
                if (message.remainingCount === 0) {
                  // No more results
                  thoughtsContainer.innerHTML = '<p>No results found for this search.</p>';
                }
                // Update the search title with the correct count
                if (searchTitle) {
                  const currentText = searchTitle.textContent || '';
                  const newText = currentText.replace(/\d+ results/, message.remainingCount + ' results');
                  searchTitle.textContent = newText;
                }
              } else if (thoughtsContainer.children.length === 0) {
                // Only show "no thoughts" if we are not in search mode
                showInitialState('no-thoughts');
              }
              
              // Update pagination if included in the message (add these lines)
              if (message.pagination) {
                updatePagination(message.pagination);
              }
              break;
              
            case 'no-db':
              showInitialState('no-db');
              break;
              
            case 'error':
              showInitialState('error', message.message);
              break;
              
            case 'initComplete':
              if (message.success) {
                vscode.postMessage({ type: 'refresh' });
              }
              break;
              
            case 'open':
              // Search for the thought by ID
              const thoughtToOpen = document.getElementById('thought-' + message.id);
              if (thoughtToOpen) {
                // Ensure it is expanded
                thoughtToOpen.classList.add('expanded');
                // Update the icon
                const expander = thoughtToOpen.querySelector('.thought-expander');
                if (expander) {
                  expander.textContent = '▼';
                }
                // Scroll to it
                thoughtToOpen.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
              break;
              
            case 'filterByType':
              thoughtsContainer.innerHTML = '';
              showInitialState('clear');
              
              // Show filter UI
              searchContainer.style.display = 'block';
              backButton.style.display = 'block'; // Show back button
              
              // Update filter UI
              if (message.isFiltered) {
                filterButton.classList.add('active');
                activeFilterText.style.display = 'block';
                activeFilterText.textContent = 'Filtered by type: ' + message.filterType;
                
                // Update the active class in dropdown
                document.querySelectorAll('.filter-item').forEach(item => {
                  item.classList.remove('active');
                  if (item.getAttribute('data-type') === message.filterType) {
                    item.classList.add('active');
                  }
                });
              } else {
                filterButton.classList.remove('active');
                activeFilterText.style.display = 'none';
              }
              
              if (message.data.length === 0) {
                thoughtsContainer.innerHTML = '<p>No memories of this type found.</p>';
              } else {
                message.data.forEach(t => thoughtsContainer.appendChild(createThoughtElement(t)));
                updateFeatureButtonStates();
              }
              break;
              
            case 'restoreOriginal':
              thoughtsContainer.innerHTML = '';
              showInitialState('clear');

              // Restore original UI
              searchContainer.style.display = 'block';
              backButton.style.display = 'none'; // Hide back button
              searchTitle.style.display = 'none'; // Hide title
              searchInput.value = ''; // Clear input

              // Reset filter state
              filterButton.classList.remove('active');
              activeFilterText.style.display = 'none';
              isFilterActive = false;
              currentFilterType = null;
              
              message.data.forEach(t => thoughtsContainer.appendChild(createThoughtElement(t)));
              updateFeatureButtonStates();
              break;
              
            case 'updatePagination':
              updatePagination(message.pagination);
              break;
              
            case 'usageStats':
              const usageCounter = document.getElementById('usage-counter');
              const usageDisplay = document.getElementById('usage-display');
              if (message.data && message.data.usage_display_text) {
                usageCounter.style.display = 'block';
                usageDisplay.textContent = (message.data.usage_display_text || '')
                  .replace(/\bthoughts\b/g, 'memories')
                  .replace(/\bThoughts\b/g, 'Memories')
                  .replace(/\bthought\b/g, 'memory')
                  .replace(/\bThought\b/g, 'Memory');
                
                usageDisplay.style.color = 'var(--vscode-descriptionForeground)';
              } else {
                usageCounter.style.display = 'none';
              }
              break;
              
            case 'updateUsage':
              const usageCounterUpdate = document.getElementById('usage-counter');
              const usageDisplayUpdate = document.getElementById('usage-display');
              if (message.usageText) {
                usageCounterUpdate.style.display = 'block';
                usageDisplayUpdate.textContent = (message.usageText || '')
                  .replace(/\bthoughts\b/g, 'memories')
                  .replace(/\bThoughts\b/g, 'Memories')
                  .replace(/\bthought\b/g, 'memory')
                  .replace(/\bThought\b/g, 'Memory');
                
                // Update global user state variables
                currentUserProfile = message.userProfile;
                isCurrentlyLoggedIn = message.isLoggedIn;
                currentFeatureAccess = message.hasFeatureAccess !== false;
                usageDisplayUpdate.style.color = 'var(--vscode-descriptionForeground)';
                updateFeatureButtonStates();
              } else {
                usageCounterUpdate.style.display = 'none';
              }
              break;
              
            case 'updateIcon':
              const titleEl = document.getElementById('sidebar-title');
              if (titleEl) {
                titleEl.textContent = 'Operational Memory';
              }

              const iconEl = document.getElementById('sidebar-icon');
              if (iconEl) {
                iconEl.classList.remove('is-secure', 'is-thought');
                if (message.icon === '🛡️') {
                  iconEl.classList.add('is-secure');
                } else {
                  iconEl.classList.add('is-thought');
                }
              }
              break;
              
            case 'initUserState':
              // Initialize user state variables from backend
              currentUserProfile = message.userProfile;
              isCurrentlyLoggedIn = message.isLoggedIn;
              
              updateFeatureButtonStates();
              break;

          }
        });

        // Add handling for search messages
        function search(searchTerm) { vscode.postMessage({ type: 'search', searchTerm }); }
        function semanticSearch(searchTerm) { vscode.postMessage({ type: 'semanticSearch', searchTerm }); }
        
        function edit(id) { vscode.postMessage({ type: 'edit', id }); }
        
        // Modified deleteThought to show confirmation modal
        let pendingSingleDelete = null;
        function deleteThought(id) {
          pendingSingleDelete = id;
          confirmationMessage.textContent = 'Are you sure you want to delete this memory? This action cannot be undone.';
          confirmationModal.classList.add('show');
        }
        
        function suggest(id) { vscode.postMessage({ type: 'suggest', id }); }
        function openFile(id) { vscode.postMessage({ type: 'open', id }); }

        // Add logic for the dropdown menu
        const menuButton = document.getElementById('menu-button');
  const dropdownMenu = document.getElementById('dropdown-menu');
  const advancedExportButton = document.getElementById('advanced-export-button');

        // Show/hide the menu when clicking the button
        menuButton.addEventListener('click', () => {
          dropdownMenu.classList.toggle('show');
        });

        // Close the menu if clicking outside of it
        document.addEventListener('click', (event) => {
          if (!menuButton.contains(event.target) && !dropdownMenu.contains(event.target)) {
            dropdownMenu.classList.remove('show');
          }
        });

        // Handle menu item events
        advancedExportButton.addEventListener('click', () => {
          vscode.postMessage({ type: 'advanced-export' });
          dropdownMenu.classList.remove('show');
        });

        // Add handler for the refresh button
        document.getElementById('refresh-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'refresh' });
        });

        // Function to update pagination controls
        function updatePagination(pagination) {
          const paginationContainer = document.getElementById('pagination');
          const paginationInfo = document.getElementById('pagination-info');
          const prevPageBtn = document.getElementById('prev-page');
          const nextPageBtn = document.getElementById('next-page');
          const pageSelector = document.getElementById('page-selector');
          
          // Save pagination state
          currentPage = pagination.current;
          totalPages = pagination.total;
          
          if (totalPages <= 1) {
            paginationContainer.style.display = 'none';
            return;
          }
          
          // Show the pagination container
          paginationContainer.style.display = 'block';
          
          // Update information text
          paginationInfo.textContent = `Page ${currentPage + 1} of ${totalPages}`;
          
          // Enable/disable buttons based on current page
          prevPageBtn.disabled = currentPage === 0;
          nextPageBtn.disabled = currentPage >= totalPages - 1;
          
          // Update page selector if there are more than 3 pages
          if (totalPages > 3) {
            pageSelector.style.display = 'block';
            pageSelector.innerHTML = '';
            
            for (let i = 0; i < totalPages; i++) {
              const option = document.createElement('option');
              option.value = i.toString();
              option.textContent = `Page ${i + 1}`;
              option.selected = i === currentPage;
              pageSelector.appendChild(option);
            }
          } else {
            pageSelector.style.display = 'none';
          }
        }
        
        // Events for pagination buttons
        document.getElementById('prev-page').addEventListener('click', () => {
          if (currentPage > 0) {
            vscode.postMessage({ type: 'gotoPage', page: currentPage - 1 });
          }
        });
        
        document.getElementById('next-page').addEventListener('click', () => {
          if (currentPage < totalPages - 1) {
            vscode.postMessage({ type: 'gotoPage', page: currentPage + 1 });
          }
        });
        
        document.getElementById('page-selector').addEventListener('change', (e) => {
          const page = parseInt(e.target.value, 10);
          vscode.postMessage({ type: 'gotoPage', page: page });
        });
        
        // Initial call to show loading state until local state is loaded
        updateFeatureButtonStates();

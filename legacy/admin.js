// Admin dashboard for approval queue
let currentUser = null;

// Initialize auth state listener
firebase.auth().onAuthStateChanged(async function(user) {
    currentUser = user;
    
    if (!user) {
        window.location.href = './login.php';
        return;
    }
    
    // Check if user is admin
    try {
        const userDoc = await db.collection('users').doc(user.uid).get();
        const userData = userDoc.data();
        
        if (!userData || !userData.isAdmin) {
            alert('Access denied. Admin privileges required.');
            window.location.href = './login.php';
            return;
        }
        
        // Load approval queue
        loadQueue();
        
    } catch (error) {
        console.error('Error checking admin status:', error);
        alert('Error checking permissions.');
        window.location.href = './login.php';
    }
});

// Sign out handler
document.addEventListener('DOMContentLoaded', function() {
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async function() {
            try {
                await firebase.auth().signOut();
                window.location.href = './login.php';
            } catch (error) {
                console.error('Sign out error:', error);
                alert('Failed to sign out: ' + error.message);
            }
        });
    }
});

async function loadQueue() {
    const queueContainer = document.getElementById('queueContainer');
    
    try {
        const queueQuery = await db.collection('users')
            .where('status', '==', 'pending_review')
            .get();
        
        if (queueQuery.empty) {
            queueContainer.innerHTML = '<div class="text-center" style="color: var(--text-muted); padding: 2rem;">No pending submissions. The queue is empty!</div>';
            return;
        }
        
        // Sort by last_submitted (client-side)
        const docs = queueQuery.docs.sort((a, b) => {
            const aTime = a.data().last_submitted ? a.data().last_submitted.seconds : 0;
            const bTime = b.data().last_submitted ? b.data().last_submitted.seconds : 0;
            return bTime - aTime; // Descending order
        });
        
        let queueHTML = '';
        docs.forEach(doc => {
            const userData = doc.data();
            const submittedDate = userData.last_submitted ? new Date(userData.last_submitted.seconds * 1000).toLocaleString() : 'Unknown date';
            
            queueHTML += `
                <div class="queue-item" data-user-id="${doc.id}">
                    <div class="queue-item-header">
                        <div class="queue-item-info">
                            <h3>${escapeHtml(userData.username || 'Unknown')}</h3>
                            <p>Email: ${escapeHtml(userData.email || 'N/A')}</p>
                            <p>Submitted: ${submittedDate}</p>
                        </div>
                        <div class="queue-item-actions">
                            <button class="btn btn-secondary" onclick="previewSubmission('${doc.id}')">Preview</button>
                            <button class="btn" onclick="approveSubmission('${doc.id}')">Approve</button>
                            <button class="btn btn-danger" onclick="rejectSubmission('${doc.id}')">Reject</button>
                        </div>
                    </div>
                </div>
            `;
        });
        
        queueContainer.innerHTML = queueHTML;
        
    } catch (error) {
        console.error('Error loading queue:', error);
        queueContainer.innerHTML = '<div class="text-center" style="color: var(--text-danger); padding: 2rem;">Error loading queue.</div>';
    }
}

function previewSubmission(userId) {
    // Open preview in new window
    db.collection('users').doc(userId).get().then(doc => {
        if (!doc.exists) {
            alert('User not found.');
            return;
        }
        
        const userData = doc.data();
        const pendingHtml = userData.pending_html || '<h1>No content</h1>';
        
        // Create preview window
        const previewWindow = window.open('', '_blank', 'width=1200,height=800');
        previewWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Preview - ${escapeHtml(userData.username)}</title>
                <style>
                    body { margin: 0; padding: 20px; background: #1a1a1a; color: #fff; }
                </style>
            </head>
            <body>
                ${pendingHtml}
            </body>
            </html>
        `);
        previewWindow.document.close();
        
    }).catch(error => {
        console.error('Error loading preview:', error);
        alert('Failed to load preview: ' + error.message);
    });
}

async function approveSubmission(userId) {
    if (!confirm('Approve this submission? This will make it live.')) {
        return;
    }
    
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            alert('User not found.');
            return;
        }
        
        const userData = userDoc.data();
        const pendingHtml = userData.pending_html;
        
        // Use transaction to ensure atomic update
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(userId);
            const userSnap = await transaction.get(userRef);
            
            if (!userSnap.exists) {
                throw new Error('User document does not exist');
            }
            
            // Set live_html = pending_html, pending_html = null, status = 'approved'
            transaction.update(userRef, {
                live_html: pendingHtml,
                pending_html: null,
                status: 'approved'
            });
        });
        
        alert('Submission approved!');
        
        // Reload queue
        loadQueue();
        
    } catch (error) {
        console.error('Error approving submission:', error);
        alert('Failed to approve: ' + error.message);
    }
}

async function rejectSubmission(userId) {
    if (!confirm('Reject this submission? The pending changes will be discarded.')) {
        return;
    }
    
    try {
        await db.collection('users').doc(userId).update({
            pending_html: null,
            status: 'rejected'
        });
        
        alert('Submission rejected.');
        
        // Reload queue
        loadQueue();
        
    } catch (error) {
        console.error('Error rejecting submission:', error);
        alert('Failed to reject: ' + error.message);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Editor functionality for pending_html management
let editorModal = null;
let editorTextarea = null;

document.addEventListener('DOMContentLoaded', function() {
    editorModal = document.getElementById('editorModal');
    editorTextarea = document.getElementById('editorTextarea');
    
    const editPageBtn = document.getElementById('editPageBtn');
    const closeEditorBtn = document.getElementById('closeEditorBtn');
    const cancelEditorBtn = document.getElementById('cancelEditorBtn');
    const submitReviewBtn = document.getElementById('submitReviewBtn');
    
    if (editPageBtn) {
        editPageBtn.addEventListener('click', openEditor);
    }
    
    if (closeEditorBtn) {
        closeEditorBtn.addEventListener('click', closeEditor);
    }
    
    if (cancelEditorBtn) {
        cancelEditorBtn.addEventListener('click', closeEditor);
    }
    
    if (submitReviewBtn) {
        submitReviewBtn.addEventListener('click', submitForReview);
    }
    
    // Close modal on overlay click
    if (editorModal) {
        editorModal.addEventListener('click', function(e) {
            if (e.target === editorModal) {
                closeEditor();
            }
        });
    }
});

async function openEditor() {
    if (!targetUserDoc || !editorModal || !editorTextarea) {
        console.error('Editor elements not found');
        return;
    }
    
    try {
        const userData = targetUserDoc.data();
        const currentUser = firebase.auth().currentUser;
        
        if (!currentUser || currentUser.uid !== targetUserDoc.id) {
            alert('You can only edit your own page.');
            return;
        }
        
        // Load pending_html if exists, otherwise load live_html
        const htmlToLoad = userData.pending_html !== null ? userData.pending_html : (userData.live_html || '<h1>Welcome to my Saloon</h1>');
        
        editorTextarea.value = htmlToLoad;
        editorModal.classList.remove('hidden');
        
        // Focus on textarea
        setTimeout(() => {
            editorTextarea.focus();
        }, 100);
        
    } catch (error) {
        console.error('Error opening editor:', error);
        alert('Failed to open editor: ' + error.message);
    }
}

function closeEditor() {
    if (editorModal) {
        editorModal.classList.add('hidden');
    }
}

async function submitForReview() {
    if (!targetUserDoc || !editorTextarea) {
        console.error('Editor elements not found');
        return;
    }
    
    const currentUser = firebase.auth().currentUser;
    if (!currentUser || currentUser.uid !== targetUserDoc.id) {
        alert('You can only submit edits for your own page.');
        return;
    }
    
    const newCode = editorTextarea.value.trim();
    
    if (!newCode) {
        alert('Please enter some HTML code.');
        return;
    }
    
    try {
        // Update Firestore user document
        // CRITICAL: Only update pending_html, status, and last_submitted
        // DO NOT update live_html
        await db.collection('users').doc(targetUserDoc.id).update({
            pending_html: newCode,
            status: 'pending_review',
            last_submitted: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        closeEditor();
        alert('Sent to the Sheriff.');
        
        // Reload the page to reflect the change (though live_html shouldn't change)
        // Actually, we can just close the editor since live_html stays the same
        
    } catch (error) {
        console.error('Error submitting for review:', error);
        alert('Failed to submit for review: ' + error.message);
    }
}

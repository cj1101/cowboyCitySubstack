// Post creation and forum thread handling
let postModal = null;
let quillEditor = null;

document.addEventListener('DOMContentLoaded', function() {
    postModal = document.getElementById('newPostModal');
    
    const newPostBtn = document.getElementById('newPostBtn');
    const closePostBtn = document.getElementById('closePostBtn');
    const cancelPostBtn = document.getElementById('cancelPostBtn');
    const createPostBtn = document.getElementById('createPostBtn');
    const postBodyEditor = document.getElementById('postBodyEditor');
    
    // Initialize Quill editor
    if (postBodyEditor) {
        quillEditor = new Quill('#postBodyEditor', {
            theme: 'snow',
            modules: {
                toolbar: [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                    [{ 'color': [] }, { 'background': [] }],
                    ['link'],
                    ['clean']
                ]
            }
        });
    }
    
    if (newPostBtn) {
        newPostBtn.addEventListener('click', openPostModal);
    }
    
    if (closePostBtn) {
        closePostBtn.addEventListener('click', closePostModal);
    }
    
    if (cancelPostBtn) {
        cancelPostBtn.addEventListener('click', closePostModal);
    }
    
    if (createPostBtn) {
        createPostBtn.addEventListener('click', createPost);
    }
    
    // Close modal on overlay click
    if (postModal) {
        postModal.addEventListener('click', function(e) {
            if (e.target === postModal) {
                closePostModal();
            }
        });
    }
});

function openPostModal() {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
        alert('Please sign in to create posts.');
        return;
    }
    
    if (!postModal) {
        console.error('Post modal not found');
        return;
    }
    
    // Reset form
    document.getElementById('postTitle').value = '';
    document.getElementById('postType').value = 'lore';
    if (quillEditor) {
        quillEditor.setContents([]);
    }
    
    postModal.classList.remove('hidden');
}

function closePostModal() {
    if (postModal) {
        postModal.classList.add('hidden');
    }
}

async function createPost() {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
        alert('Please sign in to create posts.');
        return;
    }
    
    const title = document.getElementById('postTitle').value.trim();
    const type = document.getElementById('postType').value;
    
    if (!title) {
        alert('Please enter a post title.');
        return;
    }
    
    let body = '';
    if (quillEditor) {
        body = quillEditor.root.innerHTML;
    }
    
    try {
        // Get current user's username
        const currentUserDoc = await db.collection('users').doc(currentUser.uid).get();
        const username = currentUserDoc.exists ? currentUserDoc.data().username : 'Anonymous';
        
        // Create post in Firestore
        await db.collection('posts').add({
            author_uid: currentUser.uid,
            author_username: username,
            title: title,
            body: body,
            type: type,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        closePostModal();
        
        // Reload posts feed
        if (typeof loadPostsFeed === 'function') {
            await loadPostsFeed(targetUser);
        } else {
            // Fallback: reload page
            window.location.reload();
        }
        
    } catch (error) {
        console.error('Error creating post:', error);
        alert('Failed to create post: ' + error.message);
    }
}

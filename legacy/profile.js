// Profile page renderer
let currentUser = null;
let targetUserDoc = null;

// Initialize auth state listener
firebase.auth().onAuthStateChanged(async function(user) {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/5a162c1f-106f-4ff3-bdb6-b07a46eb181e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'profile.js:6',message:'profile.js: onAuthStateChanged fired',data:{hasUser:!!user,userId:user?.uid,targetUser:targetUser,pathname:window.location.pathname},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    currentUser = user;
    
    if (!targetUser) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/5a162c1f-106f-4ff3-bdb6-b07a46eb181e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'profile.js:10',message:'profile.js: no targetUser, showing error',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        document.getElementById('designLayer').innerHTML = '<div class="login-container"><div class="login-box"><h1>Error</h1><p>No user specified</p></div></div>';
        return;
    }
    
    try {
        // Fetch target user document
        const userQuery = await db.collection('users')
            .where('username', '==', targetUser)
            .limit(1)
            .get();
        
        if (userQuery.empty) {
            document.getElementById('designLayer').innerHTML = '<div class="login-container"><div class="login-box"><h1>User Not Found</h1><p>The requested user does not exist.</p></div></div>';
            return;
        }
        
        targetUserDoc = userQuery.docs[0];
        const userData = targetUserDoc.data();
        
        // Layer 1: Render live_html
        renderDesignLayer(userData.live_html || '<h1>Welcome to my Saloon</h1>');
        
        // Layer 2: Load and render posts feed
        loadPostsFeed(targetUser);
        
        // Layer 3: Show HUD if user is owner or admin
        let shouldShowHUD = false;
        if (currentUser) {
            if (currentUser.uid === targetUserDoc.id) {
                shouldShowHUD = true;
            } else {
                // Check if current user is admin
                const currentUserDoc = await db.collection('users').doc(currentUser.uid).get();
                if (currentUserDoc.exists && currentUserDoc.data().isAdmin === true) {
                    shouldShowHUD = true;
                }
            }
        }
        if (shouldShowHUD) {
            showHUD();
        }
        
    } catch (error) {
        console.error('Error loading profile:', error);
        document.getElementById('designLayer').innerHTML = '<div class="login-container"><div class="login-box"><h1>Error</h1><p>Failed to load profile</p></div></div>';
    }
});

function renderDesignLayer(html) {
    const designLayer = document.getElementById('designLayer');
    designLayer.innerHTML = html;
}

async function loadPostsFeed(username) {
    const feedContainer = document.getElementById('feedContainer');
    
    try {
        const postsQuery = await db.collection('posts')
            .where('author_username', '==', username)
            .orderBy('timestamp', 'desc')
            .get();
        
        if (postsQuery.empty) {
            feedContainer.innerHTML = '<div class="text-center" style="color: var(--text-muted); padding: 2rem;">No posts yet.</div>';
            return;
        }
        
        let postsHTML = '';
        postsQuery.forEach(doc => {
            const post = doc.data();
            const postDate = post.timestamp ? new Date(post.timestamp.seconds * 1000).toLocaleDateString() : 'Unknown date';
            
            postsHTML += `
                <div class="post-card" data-post-id="${doc.id}" data-post-type="${post.type || 'lore'}">
                    <div class="post-header">
                        <h3 class="post-title">${escapeHtml(post.title || 'Untitled')}</h3>
                        <span class="post-type ${post.type || 'lore'}">${(post.type || 'lore').toUpperCase()}</span>
                    </div>
                    <div class="post-body">${post.body || ''}</div>
                    <div class="post-meta">
                        <span>Posted: ${postDate}</span>
                    </div>
                    ${post.type === 'forum' ? '<div class="comments-section hidden" id="comments-' + doc.id + '"></div>' : ''}
                </div>
            `;
        });
        
        feedContainer.innerHTML = postsHTML;
        
        // Add click handlers for forum posts
        postsQuery.forEach(doc => {
            const post = doc.data();
            if (post.type === 'forum') {
                const postCard = document.querySelector(`[data-post-id="${doc.id}"]`);
                if (postCard) {
                    postCard.style.cursor = 'pointer';
                    postCard.addEventListener('click', function(e) {
                        // Don't expand if clicking on comments section
                        if (e.target.closest('.comments-section')) return;
                        toggleForumThread(doc.id);
                    });
                }
            }
        });
        
    } catch (error) {
        console.error('Error loading posts:', error);
        feedContainer.innerHTML = '<div class="text-center" style="color: var(--text-danger); padding: 2rem;">Error loading posts.</div>';
    }
}

async function toggleForumThread(postId) {
    const postCard = document.querySelector(`[data-post-id="${postId}"]`);
    const commentsSection = document.getElementById(`comments-${postId}`);
    
    if (!postCard || !commentsSection) return;
    
    if (commentsSection.classList.contains('hidden')) {
        // Expand - load comments
        commentsSection.classList.remove('hidden');
        postCard.classList.add('expanded');
        await loadComments(postId, commentsSection);
    } else {
        // Collapse
        commentsSection.classList.add('hidden');
        postCard.classList.remove('expanded');
    }
}

async function loadComments(postId, container) {
    container.innerHTML = '<div class="loading">Loading comments...</div>';
    
    try {
        const commentsQuery = await db.collection('posts').doc(postId)
            .collection('comments')
            .orderBy('timestamp', 'asc')
            .get();
        
        if (commentsQuery.empty) {
            container.innerHTML = '<div class="text-center" style="color: var(--text-muted); margin: 1rem 0;">No comments yet.</div>';
        } else {
            let commentsHTML = '';
            commentsQuery.forEach(doc => {
                const comment = doc.data();
                const commentDate = comment.timestamp ? new Date(comment.timestamp.seconds * 1000).toLocaleString() : 'Unknown date';
                
                commentsHTML += `
                    <div class="comment">
                        <div class="comment-author">${escapeHtml(comment.author_username || 'Anonymous')}</div>
                        <div class="comment-body">${comment.body || ''}</div>
                        <div class="comment-meta">${commentDate}</div>
                    </div>
                `;
            });
            container.innerHTML = commentsHTML;
        }
        
        // Add comment form if user is signed in
        if (currentUser) {
            const commentFormHTML = `
                <div class="comment-form">
                    <textarea id="comment-text-${postId}" placeholder="Write a comment..."></textarea>
                    <button class="btn mt-1" onclick="addComment('${postId}')">Post Comment</button>
                </div>
            `;
            container.innerHTML += commentFormHTML;
        }
        
    } catch (error) {
        console.error('Error loading comments:', error);
        container.innerHTML = '<div class="text-center" style="color: var(--text-danger); margin: 1rem 0;">Error loading comments.</div>';
    }
}

// Global function for comment button (called from onclick)
async function addComment(postId) {
    if (!currentUser) {
        alert('Please sign in to comment.');
        return;
    }
    
    const textarea = document.getElementById(`comment-text-${postId}`);
    const body = textarea.value.trim();
    
    if (!body) {
        alert('Please enter a comment.');
        return;
    }
    
    try {
        // Get current user's username
        const currentUserDoc = await db.collection('users').doc(currentUser.uid).get();
        const username = currentUserDoc.exists ? currentUserDoc.data().username : 'Anonymous';
        
        await db.collection('posts').doc(postId)
            .collection('comments')
            .add({
                author_uid: currentUser.uid,
                author_username: username,
                body: body,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        
        textarea.value = '';
        
        // Reload comments
        const commentsSection = document.getElementById(`comments-${postId}`);
        if (commentsSection) {
            await loadComments(postId, commentsSection);
        }
        
    } catch (error) {
        console.error('Error adding comment:', error);
        alert('Failed to post comment: ' + error.message);
    }
}

function showHUD() {
    const hud = document.getElementById('hud');
    hud.classList.remove('hidden');
    
    // Add padding to design layer to account for HUD
    document.getElementById('designLayer').style.paddingTop = '60px';
}

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

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Signup page handler - handles username input and user creation

let isProcessing = false;

// Check authentication state on page load
firebase.auth().onAuthStateChanged(async function(user) {
    if (!user) {
        // Not authenticated - redirect to login
        window.location.href = './login.php';
        return;
    }
    
    // Check if user already exists in Firestore
    try {
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            // User already exists - redirect to their profile
            const username = userDoc.data().username;
            window.location.href = './profile.php?u=' + encodeURIComponent(username);
            return;
        }
        // User doesn't exist, continue with signup form
    } catch (error) {
        console.error('Error checking user existence:', error);
        showError('An error occurred. Please try again.');
    }
});

document.addEventListener('DOMContentLoaded', function() {
    const signupForm = document.getElementById('signupForm');
    const usernameInput = document.getElementById('usernameInput');
    const submitBtn = document.getElementById('submitBtn');
    const errorMessage = document.getElementById('errorMessage');
    
    if (!signupForm || !usernameInput || !submitBtn || !errorMessage) {
        console.error('Required elements not found');
        return;
    }
    
    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }
    
    function hideError() {
        errorMessage.style.display = 'none';
    }
    
    signupForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        if (isProcessing) {
            return;
        }
        
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) {
            window.location.href = './login.php';
            return;
        }
        
        hideError();
        isProcessing = true;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating Account...';
        
        let username = usernameInput.value.trim();
        
        // Validate username format
        if (!username) {
            showError('Username is required.');
            isProcessing = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
            return;
        }
        
        // Clean username (alphanumeric and underscores only)
        username = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
        
        if (username.length === 0) {
            showError('Invalid username. Use only letters, numbers, and underscores.');
            isProcessing = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
            return;
        }
        
        // Check uniqueness
        try {
            const existingUser = await db.collection('users')
                .where('username', '==', username)
                .limit(1)
                .get();
            
            if (!existingUser.empty) {
                showError('Username already taken. Please choose another.');
                isProcessing = false;
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Account';
                usernameInput.focus();
                return;
            }
            
            // Create user document
            const userData = {
                username: username,
                email: currentUser.email,
                role: 'creator',
                isAdmin: false,
                live_html: '<h1>Welcome to my Saloon</h1>',
                pending_html: null,
                status: 'approved',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            
            await db.collection('users').doc(currentUser.uid).set(userData);
            console.log('User created:', currentUser.uid);
            
            // Redirect to their profile page
            window.location.href = './profile.php?u=' + encodeURIComponent(username);
            
        } catch (error) {
            console.error('Error creating user:', error);
            showError('Failed to create account: ' + error.message);
            isProcessing = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Account';
        }
    });
    
    // Hide error when user starts typing
    usernameInput.addEventListener('input', function() {
        hideError();
    });
});


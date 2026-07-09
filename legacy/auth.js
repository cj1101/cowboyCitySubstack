// Google Sign-In handler

// Track if we're handling a redirect to prevent double-redirects
let isRedirecting = false;

// Centralized redirect logic
async function checkUserAndRedirect(user) {
    if (isRedirecting) return;

    // Check if we are already on the correct page to avoid infinite loops
    // (Though simple file checks like includes('signup.php') might be brittle if URL params exist, 
    // for this logic we just want to move them away from login.php)

    isRedirecting = true;
    console.log('Checking user profile for redirection...');

    try {
        const userDoc = await db.collection('users').doc(user.uid).get();

        if (!userDoc.exists) {
            // New user - redirect to signup page
            console.log('New user, redirecting to signup');
            window.location.href = './signup.php';
        } else {
            // Existing user - redirect to their profile page
            const userData = userDoc.data();
            if (userData && userData.username) {
                console.log('Existing user, redirecting to profile');
                window.location.href = './profile.php?u=' + encodeURIComponent(userData.username);
            } else {
                console.error('User document exists but has no username:', userData);
                alert('Account error: Missing username. Please contact support.');
                isRedirecting = false;
            }
        }
    } catch (error) {
        console.error('Error checking user in Firestore:', error);
        alert('Connection error. Please try again.');
        isRedirecting = false;
    }
}

// Listen for auth state changes - primary source of truth for redirection
firebase.auth().onAuthStateChanged(function (user) {
    if (user) {
        checkUserAndRedirect(user);
    }
});

document.addEventListener('DOMContentLoaded', function () {
    // Handle redirect result if user was redirected back from Google
    // Primarily for error handling now, as onAuthStateChanged catches the success case
    handleRedirectResult();

    const loginBtn = document.getElementById('loginBtn');
    const signupBtn = document.getElementById('signupBtn');

    if (loginBtn) {
        loginBtn.addEventListener('click', handleGoogleSignIn);
    }

    if (signupBtn) {
        signupBtn.addEventListener('click', handleGoogleSignIn);
    }
});

async function handleGoogleSignIn() {
    const provider = new firebase.auth.GoogleAuthProvider();

    try {
        await firebase.auth().signInWithRedirect(provider);
    } catch (error) {
        console.error('Redirect sign-in error:', error);
        alert('Failed to sign in: ' + error.message);
    }
}

// Handle redirect result when page loads
async function handleRedirectResult() {
    try {
        const result = await firebase.auth().getRedirectResult();
        // We only care about errors here. Success is handled by onAuthStateChanged.
    } catch (error) {
        console.error('Redirect result error:', error);
        if (error.code && error.code !== 'auth/operation-not-allowed') {
            alert('Failed to complete sign-in: ' + error.message);
        }
    }
}

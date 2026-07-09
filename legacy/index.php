<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Home - Cowboy City</title>
    <link rel="stylesheet" href="./style.css">
    
    <!-- Firebase SDK v8 -->
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
</head>
<body>
    <!-- HUD -->
    <div class="hud">
        <div class="hud-title">🤠 Cowboy City</div>
        <div class="hud-buttons">
            <a href="#" id="accountLink" class="btn btn-secondary" style="text-decoration: none;">My Account</a>
            <button id="signOutBtn" class="btn btn-secondary">Sign Out</button>
        </div>
    </div>

    <div class="admin-container">
        <div class="admin-header">
            <h1>The Feed</h1>
            <p>All posts in chronological order</p>
        </div>
        
        <div id="feedContainer" class="queue-list">
            <div class="loading">Loading posts...</div>
        </div>
    </div>

    <script src="./firebase_config.js"></script>
    <script src="./home.js"></script>
    <script>
        // Update account link with user's username after authentication
        firebase.auth().onAuthStateChanged(async function(user) {
            if (user) {
                try {
                    const userDoc = await db.collection('users').doc(user.uid).get();
                    if (userDoc.exists) {
                        const username = userDoc.data().username;
                        const accountLink = document.getElementById('accountLink');
                        if (accountLink) {
                            accountLink.href = './profile.php?u=' + encodeURIComponent(username);
                        }
                    }
                } catch (error) {
                    console.error('Error fetching user data:', error);
                }
            }
        });
    </script>
</body>
</html>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enter Cowboy City</title>
    <link rel="stylesheet" href="./style.css">
    
    <!-- Firebase SDK v8 -->
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
</head>
<body>
    <div class="login-container">
        <div class="login-box">
            <h1>🤠 Cowboy City</h1>
            <p>Welcome, partner. Identify yourself.</p>
            <div class="auth-buttons">
                <button id="loginBtn" class="btn">Login</button>
                <button id="signupBtn" class="btn btn-secondary">Sign Up</button>
            </div>
            <p style="margin-top: 1rem; font-size: 0.9rem; opacity: 0.8;">Both options utilize Google OAuth</p>
        </div>
    </div>

    <script src="./firebase_config.js"></script>
    <script src="./auth.js"></script>
</body>
</html>

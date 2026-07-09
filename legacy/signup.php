<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sign Up - Cowboy City</title>
    <link rel="stylesheet" href="./style.css">
    
    <!-- Firebase SDK v8 -->
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
</head>
<body>
    <div class="login-container">
        <div class="login-box">
            <h1>🤠 Welcome to Cowboy City</h1>
            <p>Choose your username to get started</p>
            <form id="signupForm">
                <div class="form-group">
                    <label for="usernameInput">Username:</label>
                    <input type="text" id="usernameInput" placeholder="Enter your username" required autofocus>
                    <div id="errorMessage" style="color: #ff6b6b; margin-top: 0.5rem; font-size: 0.9rem; display: none;"></div>
                </div>
                <button type="submit" class="btn" id="submitBtn">Create Account</button>
            </form>
        </div>
    </div>

    <script src="./firebase_config.js"></script>
    <script src="./signup.js"></script>
</body>
</html>


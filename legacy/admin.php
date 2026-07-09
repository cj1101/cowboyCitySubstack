<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sheriff's Dashboard - Cowboy City</title>
    <link rel="stylesheet" href="./style.css">
    
    <!-- Firebase SDK v8 -->
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
</head>
<body>
    <!-- HUD -->
    <div class="hud">
        <div class="hud-title">🤠 Sheriff's Dashboard</div>
        <div class="hud-buttons">
            <button id="signOutBtn" class="btn btn-secondary">Sign Out</button>
        </div>
    </div>

    <div class="admin-container">
        <div class="admin-header">
            <h1>The Approval Queue</h1>
            <p>Review and approve pending page submissions</p>
        </div>
        
        <div id="queueContainer" class="queue-list">
            <div class="loading">Loading queue...</div>
        </div>
    </div>

    <script src="./firebase_config.js"></script>
    <script src="./admin.js"></script>
</body>
</html>

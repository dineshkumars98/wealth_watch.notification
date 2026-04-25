const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Firebase Admin securely using Environment Variables
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized successfully.");
  } catch (error) {
    console.error("Failed to initialize Firebase Admin:", error);
  }
}

app.post('/send-notification', async (req, res) => {
  try {
    // 1. Extract the 'data' field from the incoming Flutter request
    const { token, title, body, data } = req.body;

    const message = {
      token: token,
      notification: {
        title: title,
        body: body
      },
      // 2. IMPORTANT: Forward the data object to Firebase!
      data: data
    };

    const response = await admin.messaging().send(message);
    res.status(200).send({ success: true, response });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
